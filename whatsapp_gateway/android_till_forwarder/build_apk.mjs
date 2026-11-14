import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const javaBin = 'C:\\Program Files\\Microsoft\\jdk-21.0.12.101-hotspot\\bin';
const btDir = 'C:\\Users\\user\\AppData\\Local\\Android\\Sdk\\build-tools\\android-14';
const androidJar = 'C:\\Users\\user\\AppData\\Local\\Android\\Sdk\\platforms\\android-34\\android.jar';
const projDir = 'C:\\Users\\user\\Documents\\Perpetual\\whatsapp_gateway\\android_till_forwarder';
const buildDir = path.join(projDir, 'build');
const classesDir = path.join(buildDir, 'classes');
const dexDir = path.join(buildDir, 'dex');
const srcDir = path.join(projDir, 'app', 'src', 'main', 'java', 'cloud', 'missperpetual', 'tillforwarder');
const manifest = path.join(projDir, 'app', 'src', 'main', 'AndroidManifest.xml');
const resDir = path.join(projDir, 'app', 'src', 'main', 'res');

console.log('Preparing directories...');
if (fs.existsSync(classesDir)) fs.rmSync(classesDir, { recursive: true, force: true });
if (fs.existsSync(dexDir)) fs.rmSync(dexDir, { recursive: true, force: true });
fs.mkdirSync(classesDir, { recursive: true });
fs.mkdirSync(dexDir, { recursive: true });

console.log('1. Compiling Java sources...');
const javaFiles = fs.readdirSync(srcDir)
  .filter(f => f.endsWith('.java'))
  .map(f => path.join(srcDir, f));

execSync(`"${path.join(javaBin, 'javac.exe')}" --release 8 -encoding UTF-8 -classpath "${androidJar}" -d "${classesDir}" ${javaFiles.map(f => `"${f}"`).join(' ')}`, { stdio: 'inherit' });

console.log('2. Converting to DEX with d8...');
const getAllFiles = (dir) => {
  let results = [];
  fs.readdirSync(dir).forEach(file => {
    const full = path.join(dir, file);
    if (fs.statSync(full).isDirectory()) results.push(...getAllFiles(full));
    else if (full.endsWith('.class')) results.push(full);
  });
  return results;
};
const classFiles = getAllFiles(classesDir);
execSync(`"${path.join(btDir, 'd8.bat')}" --lib "${androidJar}" --min-api 23 --output "${dexDir}" ${classFiles.map(f => `"${f}"`).join(' ')}`, { stdio: 'inherit' });

console.log('3. Compiling resources with aapt2...');
const resZip = path.join(buildDir, 'res_compiled.zip');
execSync(`"${path.join(btDir, 'aapt2.exe')}" compile --dir "${resDir}" -o "${resZip}"`, { stdio: 'inherit' });

console.log('4. Linking APK with aapt2...');
const unalignedApk = path.join(buildDir, 'unaligned.apk');
execSync(`"${path.join(btDir, 'aapt2.exe')}" link -I "${androidJar}" --manifest "${manifest}" -o "${unalignedApk}" "${resZip}"`, { stdio: 'inherit' });

console.log('5. Packaging classes.dex into APK...');
execSync(`"${path.join(javaBin, 'jar.exe')}" uf "${unalignedApk}" -C "${dexDir}" classes.dex`, { stdio: 'inherit' });

console.log('6. Running zipalign...');
const alignedApk = path.join(buildDir, 'aligned.apk');
if (fs.existsSync(alignedApk)) fs.unlinkSync(alignedApk);
execSync(`"${path.join(btDir, 'zipalign.exe')}" -f -p 4 "${unalignedApk}" "${alignedApk}"`, { stdio: 'inherit' });

console.log('7. Signing APK with apksigner using original release keystore...');
const keystore = path.join(projDir, 'savannah-release.jks');
const finalApk = path.join(projDir, 'SavannahTillRelay.apk');

execSync(`"${path.join(btDir, 'apksigner.bat')}" sign --ks "${keystore}" --ks-pass pass:savannah2026 --key-pass pass:savannah2026 --out "${finalApk}" "${alignedApk}"`, { stdio: 'inherit' });

console.log('8. Verifying signed APK...');
execSync(`"${path.join(btDir, 'apksigner.bat')}" verify "${finalApk}"`, { stdio: 'inherit' });

const stat = fs.statSync(finalApk);
console.log(`BUILD SUCCESS! Output: ${finalApk} (${(stat.size / 1024).toFixed(1)} KB)`);

// Also copy to desktop and public downloads
try {
  const desktopPath = 'C:\\Users\\user\\Desktop\\SavannahTillRelay.apk';
  fs.copyFileSync(finalApk, desktopPath);
  console.log(`Copied to: ${desktopPath}`);
} catch (err) {}
