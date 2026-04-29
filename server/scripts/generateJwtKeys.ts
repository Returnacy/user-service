import { generateKeyPairSync, randomBytes } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const kid = randomBytes(16).toString('hex');

const sep = '='.repeat(72);

console.log(sep);
console.log('JWT_PRIVATE_KEY (paste as a single Railway variable, multi-line is fine)');
console.log(sep);
console.log(privateKey);
console.log(sep);
console.log('JWT_PUBLIC_KEY');
console.log(sep);
console.log(publicKey);
console.log(sep);
console.log('JWT_KID');
console.log(sep);
console.log(kid);
console.log(sep);
console.log('Note: also set JWT_ISSUER to user-service\'s public URL,');
console.log('e.g. https://user-service-production-f74c.up.railway.app');
console.log(sep);
