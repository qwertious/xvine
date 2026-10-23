"""Build the xVine Android APK without Gradle.

    python android/build_apk.py --nodejs-mobile DIR [--abi arm64-v8a] [--abi x86_64]
                                [--sdk C:/Android/Sdk] [--ndk DIR] [--out FILE]

DIR is the unpacked nodejs-mobile-v18.20.4-android.zip (it has bin/<abi>/libnode.so).
One APK per call; pass several --abi for a fat APK (each ABI adds ~25 MB).

Pipeline: NDK clang++ (JNI bridge) -> aapt2 (manifest, resources, assets) ->
javac -> d8 -> zip in dex + native libs -> zipalign -> apksigner.
The signing key lives in ~/.config/xvine-android, never in the site tree.
"""
import argparse
import glob
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ABIS = {
    'arm64-v8a': ('aarch64-linux-android', 'aarch64-linux-android'),
    'armeabi-v7a': ('armv7a-linux-androideabi', 'arm-linux-androideabi'),
    'x86_64': ('x86_64-linux-android', 'x86_64-linux-android'),
}
MIN_SDK = 24
TARGET_SDK = 34


def run(cmd, env=None):
    shown, hide = [], False
    for i, c in enumerate(cmd):  # never echo the keystore password
        shown.append('***' if hide or c.startswith('pass:') else (os.path.basename(c) if i == 0 else c))
        hide = c in ('-storepass', '-keypass')
    print('  $', ' '.join(shown)[:220])
    subprocess.run(cmd, check=True, env=env)


def find_jdk():
    for base in [os.environ.get('JAVA_HOME', '')] + sorted(glob.glob('C:/Program Files/Microsoft/jdk-*'), reverse=True) + \
            sorted(glob.glob('C:/Program Files/Eclipse Adoptium/jdk-*'), reverse=True) + ['/usr/lib/jvm/default-java']:
        if base and os.path.exists(os.path.join(base, 'bin', 'javac' + ('.exe' if os.name == 'nt' else ''))):
            return base
    sys.exit('No JDK 11+ found (set JAVA_HOME)')


def make_icons(res_dir):
    """Launcher icon: the xVine mark, white on black, at each density."""
    from PIL import Image, ImageDraw
    for name, px in [('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)]:
        s = px * 4  # draw large, downsample for smooth edges
        img = Image.new('RGB', (s, s), (0, 0, 0))
        d = ImageDraw.Draw(img)
        k = s / 100.0
        w = int(7 * k)

        def pt(x, y):
            return (x * k, y * k)

        def curve(p0, p1, p2, p3, n=40):
            pts = []
            for i in range(n + 1):
                t = i / n
                a = (1 - t) ** 3; b = 3 * (1 - t) ** 2 * t; c = 3 * (1 - t) * t ** 2; e = t ** 3
                pts.append(pt(a * p0[0] + b * p1[0] + c * p2[0] + e * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + e * p3[1]))
            return pts

        fg = (242, 242, 242)
        d.line([pt(50, 90), pt(50, 52)], fill=fg, width=w)
        d.line(curve((50, 52), (50, 36), (32, 34), (26, 18)), fill=fg, width=w, joint='curve')
        d.line(curve((50, 52), (50, 38), (66, 36), (74, 22)), fill=fg, width=w, joint='curve')
        d.line(curve((50, 70), (60, 66), (70, 66), (80, 58)), fill=fg, width=w, joint='curve')
        for (cx, cy, r) in [(26, 18, 8), (74, 22, 8), (80, 58, 7), (50, 52, 6), (50, 90, 3.5)]:
            d.ellipse([pt(cx - r, cy - r), pt(cx + r, cy + r)], fill=fg)
        out = os.path.join(res_dir, 'mipmap-' + name)
        os.makedirs(out, exist_ok=True)
        img.resize((px, px), Image.LANCZOS).save(os.path.join(out, 'ic_launcher.png'))


def keystore():
    d = os.path.join(os.path.expanduser('~'), '.config', 'xvine-android')
    os.makedirs(d, exist_ok=True)
    ks = os.path.join(d, 'xvine.keystore')
    pw_file = os.path.join(d, 'keystore-password.txt')
    if not os.path.exists(ks):
        pw = secrets.token_urlsafe(18)
        with open(pw_file, 'w') as f:
            f.write(pw)
        run([os.path.join(find_jdk(), 'bin', 'keytool'), '-genkeypair', '-keystore', ks, '-alias', 'xvine', '-keyalg', 'RSA', '-keysize', '3072',
             '-validity', '10000', '-storepass', pw, '-keypass', pw, '-dname', 'CN=XIO xVine, O=XIO'])
    return ks, open(pw_file).read().strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--nodejs-mobile', required=True)
    ap.add_argument('--abi', action='append', choices=sorted(ABIS))
    ap.add_argument('--sdk', default=os.environ.get('ANDROID_HOME', 'C:/Android/Sdk'))
    ap.add_argument('--ndk')
    ap.add_argument('--out')
    ap.add_argument('--debug', action='store_true', help='debuggable build (adb run-as) for testing')
    a = ap.parse_args()
    abis = a.abi or ['arm64-v8a']
    version = json.load(open(os.path.join(ROOT, 'package.json'), encoding='utf-8'))['version']
    ndk = a.ndk or sorted(glob.glob(os.path.join(a.sdk, 'ndk', '*')))[-1]
    host = 'windows-x86_64' if os.name == 'nt' else 'linux-x86_64'
    llvm = os.path.join(ndk, 'toolchains', 'llvm', 'prebuilt', host)
    bt = sorted(glob.glob(os.path.join(a.sdk, 'build-tools', '*')))[-1]
    android_jar = sorted(glob.glob(os.path.join(a.sdk, 'platforms', 'android-*', 'android.jar')))[-1]
    exe = '.exe' if os.name == 'nt' else ''
    bat = '.bat' if os.name == 'nt' else ''
    jdk = find_jdk()
    env = dict(os.environ, JAVA_HOME=jdk, PATH=os.path.join(jdk, 'bin') + os.pathsep + os.environ['PATH'])

    # Build outside the synced site tree: it holds ~200 MB of native libraries.
    build = os.path.join(tempfile.gettempdir(), 'xvine-apk-build')
    shutil.rmtree(build, ignore_errors=True)
    os.makedirs(build)
    print('xVine', version, 'APK for', ', '.join(abis))

    # 1. Native libs: libnode + the NDK C++ runtime + our JNI bridge.
    libs = {}
    for abi in abis:
        clang_target, sysroot_triple = ABIS[abi]
        node_dir = os.path.join(a.nodejs_mobile, 'bin', abi)
        out_dir = os.path.join(build, 'lib', abi)
        os.makedirs(out_dir)
        run([os.path.join(llvm, 'bin', 'clang++' + exe), '--target=%s%d' % (clang_target, MIN_SDK), '-O2', '-fPIC', '-shared',
             '-fno-exceptions', '-fno-rtti', '-nostdlib++', '-Wl,-soname,libxvinenode.so', '-Wl,-z,max-page-size=16384',
             os.path.join(HERE, 'jni', 'xvine_node.cpp'), '-L' + node_dir, '-lnode', '-llog',
             '-o', os.path.join(out_dir, 'libxvinenode.so')], env)
        shutil.copy(os.path.join(node_dir, 'libnode.so'), out_dir)
        shutil.copy(os.path.join(llvm, 'sysroot', 'usr', 'lib', sysroot_triple, 'libc++_shared.so'), out_dir)
        libs[abi] = out_dir

    # 2. Assets: the server and UI exactly as on desktop.
    assets = os.path.join(build, 'assets', 'xvine')
    listing = []
    for d in ['server', 'web']:
        for base, dirs, files in os.walk(os.path.join(ROOT, d)):
            dirs[:] = [x for x in dirs if not x.startswith('.')]
            for f in files:
                src = os.path.join(base, f)
                rel = os.path.relpath(src, ROOT).replace(os.sep, '/')
                os.makedirs(os.path.dirname(os.path.join(assets, rel)), exist_ok=True)
                shutil.copy(src, os.path.join(assets, rel))
                listing.append(rel)
    shutil.copy(os.path.join(ROOT, 'package.json'), assets)
    listing.append('package.json')
    with open(os.path.join(assets, 'files.txt'), 'w', newline='\n') as f:
        f.write('\n'.join(sorted(listing)) + '\n')

    # 3. Resources + manifest.
    res = os.path.join(build, 'res')
    shutil.copytree(os.path.join(HERE, 'res'), res)
    make_icons(res)
    run([os.path.join(bt, 'aapt2' + exe), 'compile', '--dir', res, '-o', os.path.join(build, 'res.zip')], env)
    gen = os.path.join(build, 'gen')
    base_apk = os.path.join(build, 'base.apk')
    run([os.path.join(bt, 'aapt2' + exe), 'link', '-o', base_apk, '-I', android_jar,
         '--manifest', os.path.join(HERE, 'AndroidManifest.xml'), '-A', os.path.join(build, 'assets'),
         '--java', gen] + (['--debug-mode'] if a.debug else []) + ['--min-sdk-version', str(MIN_SDK), '--target-sdk-version', str(TARGET_SDK),
         '--version-name', version, '--version-code', str(int(''.join('%02d' % int(x) for x in version.split('.'))) or 1),
         os.path.join(build, 'res.zip')], env)

    # 4. Java -> dex.
    classes = os.path.join(build, 'classes')
    sources = glob.glob(os.path.join(HERE, 'java', '**', '*.java'), recursive=True) + \
        glob.glob(os.path.join(gen, '**', '*.java'), recursive=True)
    run([os.path.join(jdk, 'bin', 'javac' + exe), '--release', '8', '-nowarn', '-Xlint:-options', '-classpath', android_jar,
         '-d', classes] + sources, env)
    dex = os.path.join(build, 'dex')
    os.makedirs(dex)
    run([os.path.join(bt, 'd8' + bat), '--release', '--min-api', str(MIN_SDK), '--lib', android_jar, '--output', dex] +
        glob.glob(os.path.join(classes, '**', '*.class'), recursive=True), env)

    # 5. Assemble, align, sign.
    # A fresh zip (appending to aapt2's output trips zipalign's header checks).
    unsigned = os.path.join(build, 'unsigned.apk')
    with zipfile.ZipFile(base_apk) as src, zipfile.ZipFile(unsigned, 'w', zipfile.ZIP_DEFLATED) as z:
        for info in src.infolist():
            data = src.read(info.filename)
            # resources.arsc must stay uncompressed (required from API 30).
            z.writestr(info.filename, data, zipfile.ZIP_STORED if info.compress_type == zipfile.ZIP_STORED else zipfile.ZIP_DEFLATED)
        z.write(os.path.join(dex, 'classes.dex'), 'classes.dex')
        for abi, d in libs.items():
            for so in sorted(os.listdir(d)):
                z.write(os.path.join(d, so), 'lib/%s/%s' % (abi, so))
    aligned = os.path.join(build, 'aligned.apk')
    run([os.path.join(bt, 'zipalign' + exe), '-f', '4', unsigned, aligned], env)
    out = a.out or os.path.join(ROOT, 'dist', 'xvine-%s-%s.apk' % (version, '+'.join(abis)))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    ks, pw = keystore()
    run([os.path.join(bt, 'apksigner' + bat), 'sign', '--v4-signing-enabled', 'false', '--ks', ks, '--ks-pass', 'pass:' + pw, '--ks-key-alias', 'xvine',
         '--out', out, aligned], env)
    run([os.path.join(bt, 'apksigner' + bat), 'verify', out], env)
    print('built %s (%.1f MB)' % (out, os.path.getsize(out) / 1048576))


if __name__ == '__main__':
    main()
