import { execSync } from 'child_process';

const adb = 'C:\\Users\\user\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe';
const apk = 'C:\\Users\\user\\Documents\\Perpetual\\whatsapp_gateway\\android_till_forwarder\\SavannahTillRelay.apk';

console.log('1. Pushing to /data/local/tmp...');
execSync(`"${adb}" -s 94b0fd4c push "${apk}" /data/local/tmp/SavannahTillRelay.apk`, { stdio: 'inherit' });

console.log('2. Installing via pm install...');
const out = execSync(`"${adb}" -s 94b0fd4c shell pm install -r /data/local/tmp/SavannahTillRelay.apk`, { encoding: 'utf8' });
console.log('PM INSTALL RESULT:', out);

console.log('3. Granting SMS permissions...');
try {
  execSync(`"${adb}" -s 94b0fd4c shell pm grant cloud.missperpetual.tillforwarder android.permission.RECEIVE_SMS`, { stdio: 'inherit' });
  execSync(`"${adb}" -s 94b0fd4c shell pm grant cloud.missperpetual.tillforwarder android.permission.READ_SMS`, { stdio: 'inherit' });
  console.log('PERMISSIONS GRANTED SUCCESSFULLY!');
} catch (e) {
  console.warn('Grant warning:', e.message);
}

console.log('4. Launching MainActivity to verify...');
try {
  execSync(`"${adb}" -s 94b0fd4c shell am start -n cloud.missperpetual.tillforwarder/.MainActivity`, { stdio: 'inherit' });
  console.log('APP LAUNCHED SUCCESSFULLY ON REDMI NOTE 12!');
} catch (e) {
  console.warn('Launch warning:', e.message);
}
