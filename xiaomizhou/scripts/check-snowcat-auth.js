import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

// Execute the upstream implementation unchanged, resolving its in-memory store
// as a data module. No QQ, native hooks, credentials or live account required.
const source = path.resolve(process.argv[2] || 'data/snowcat-source');
const moduleUrl = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
const store = stripTypeScriptTypes(fs.readFileSync(path.join(source, 'packages/snowcat-common/src/store.ts'), 'utf8'));
const original = fs.readFileSync(path.join(source, 'packages/snowcat-webui-backend/src/helper/SignToken.ts'), 'utf8');
const implementation = stripTypeScriptTypes(original).replace(/(['"])snowcat-common\/src\/store\1/, JSON.stringify(moduleUrl(store)));
const { AuthHelper } = await import(moduleUrl(implementation));
const token = crypto.randomBytes(32).toString('hex');
const legacyHash = crypto.createHash('sha256').update(token + '.napcat').digest('hex');
const generatedHash = AuthHelper.generatePasswordHash(token);
const check = hash => {
  const credential = AuthHelper.signCredential(hash);
  return { passwordAccepted: AuthHelper.comparePasswordHash(token, hash), signatureAccepted: AuthHelper.checkCredential(credential), credentialAccepted: AuthHelper.validateCredentialWithinOneHour(token, credential) };
};
const result = { legacy: check(legacyHash), generated: check(generatedHash) };
console.log(JSON.stringify(result, null, 2));
if (!result.legacy.passwordAccepted || !result.legacy.signatureAccepted) throw new Error('Upstream login/signature behavior is incompatible');
if (!result.legacy.credentialAccepted) {
  console.error('SnowCat 上游签发的有效凭证无法通过自身验证。停止扫码/镜像验收，不能报告适配可用。');
  if (process.argv.includes('--require-working')) process.exitCode = 1;
}
