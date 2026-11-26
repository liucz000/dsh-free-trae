/**
 * Qoder COSY `/algo/` 网关的全部密码学原语（纯计算、无网络）。
 *
 * 逐条对齐 玖念/traework2api 的 QoderCosyCrypto.kt（它又对齐 qodercli2api 的 Go 实现）：
 *   1. 请求体先过自定义 base64，再把首尾各三分之一对调；
 *   2. Authorization = `Bearer COSY.<payloadB64>.<md5>`；
 *   3. 登录时生成一次运行时字段：AES-128-CBC 加密的用户信息 + RSA-PKCS1v15 加密的 AES key。
 *
 * 任何一处差一个字节，上游只会回 401/400，所以这里保持逐字节复刻。
 *
 * @module src/qoder/cosy.js
 */

import crypto from 'node:crypto'

export const COSY_VERSION = '1.1.74'

export const NATIVE_INFER_PATH = '/algo/api/v2/service/pro/sse/agent_chat_generation'
export const COSY_SIGNED_PATH = '/api/v2/service/pro/sse/agent_chat_generation'
export const NATIVE_INFER_QUERY = '?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1'

export const NATIVE_MODEL_LIST_PATH = '/algo/api/v2/model/list'
export const MODEL_LIST_SIGNED_PATH = '/api/v2/model/list'

const BODY_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
const BODY_PAD = '$'

/** Qoder 内置公钥（1024-bit，SubjectPublicKeyInfo，不是服务端私钥）。 */
const RUNTIME_PUBLIC_KEY_B64 = [
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc',
  '4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l',
  '6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17',
  'XcW+ML9FoCI6AOvOzwIDAQAB',
].join('')

function b64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

export function md5Hex(text) {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex')
}

/** 自定义 base64（字母表不同，填充是 `$`）。 */
export function customBase64Encode(raw) {
  const src = Buffer.from(raw)
  const length = Math.ceil(src.length / 3) * 4
  const out = Buffer.alloc(length)
  let i = 0
  let o = 0
  while (i + 3 <= src.length) {
    const b0 = src[i]
    const b1 = src[i + 1]
    const b2 = src[i + 2]
    out[o++] = BODY_ALPHABET.charCodeAt((b0 >> 2) & 0x3f)
    out[o++] = BODY_ALPHABET.charCodeAt(((b0 << 4) | (b1 >> 4)) & 0x3f)
    out[o++] = BODY_ALPHABET.charCodeAt(((b1 << 2) | (b2 >> 6)) & 0x3f)
    out[o++] = BODY_ALPHABET.charCodeAt(b2 & 0x3f)
    i += 3
  }
  const rest = src.length - i
  if (rest === 1) {
    const b0 = src[i]
    out[o++] = BODY_ALPHABET.charCodeAt((b0 >> 2) & 0x3f)
    out[o++] = BODY_ALPHABET.charCodeAt((b0 << 4) & 0x3f)
    out[o++] = BODY_PAD.charCodeAt(0)
    out[o] = BODY_PAD.charCodeAt(0)
  } else if (rest === 2) {
    const b0 = src[i]
    const b1 = src[i + 1]
    out[o++] = BODY_ALPHABET.charCodeAt((b0 >> 2) & 0x3f)
    out[o++] = BODY_ALPHABET.charCodeAt(((b0 << 4) | (b1 >> 4)) & 0x3f)
    out[o++] = BODY_ALPHABET.charCodeAt((b1 << 2) & 0x3f)
    out[o] = BODY_PAD.charCodeAt(0)
  }
  return out
}

/** 首尾各三分之一对调（自反：做两次等于没做）。 */
export function swapOuterThirds(raw) {
  const src = Buffer.from(raw)
  const q = Math.floor(src.length / 3)
  const out = Buffer.alloc(src.length)
  let o = 0
  for (let i = src.length - q; i < src.length; i++) out[o++] = src[i]
  for (let i = q; i < src.length - q; i++) out[o++] = src[i]
  for (let i = 0; i < q; i++) out[o++] = src[i]
  return out
}

export function encodeBody(raw) {
  return swapOuterThirds(customBase64Encode(raw))
}

export function reverseMaskUUID(raw) {
  const src = Buffer.from(raw)
  if (src.length !== 16) throw new Error('UUID 原始字节必须是 16 个')
  const out = Buffer.alloc(16)
  for (let i = 0; i < 16; i++) out[i] = src[15 - i]
  out[6] = (out[6] & 0x0f) | 0x40
  out[8] = (out[8] & 0x3f) | 0x80
  return out
}

export function formatLowerUUID(bytes) {
  const hex = Buffer.from(bytes).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function runtimeASCIIKey(uuidBytes) {
  return Buffer.from(uuidBytes).subarray(0, 8).toString('hex')
}

export function newRequestId() {
  return formatLowerUUID(reverseMaskUUID(crypto.randomBytes(16)))
}

export function authorizationPayload(requestId, info, cosyVersion = COSY_VERSION) {
  const json = JSON.stringify({
    version: 'v1',
    requestId,
    info,
    cosyVersion,
    ideVersion: '',
  })
  return b64(Buffer.from(json, 'utf8'))
}

export function authorization(payloadB64, key, unixSeconds, encodedBody, signedPath = COSY_SIGNED_PATH) {
  const signature = md5Hex(`${payloadB64}\n${key}\n${unixSeconds}\n${encodedBody}\n${signedPath}`)
  return `Bearer COSY.${payloadB64}.${signature}`
}

export function runtimeFieldInputJson({ uid, jobToken, organizationId, organizationTags, dataPolicyAgreed }) {
  const obj = { uid: String(uid ?? '') }
  if (typeof jobToken === 'string' && jobToken !== '') obj.security_oauth_token = jobToken
  obj.organization_id = String(organizationId ?? '')
  obj.organization_tags = Array.isArray(organizationTags) ? organizationTags.map(String) : []
  obj.data_policy_agreed = dataPolicyAgreed === true
  return JSON.stringify(obj)
}

/** 登录时生成一次，之后缓存；jobToken 变了才重新生成。 */
export function generateRuntimeFields({ uid, jobToken, organizationId, organizationTags, dataPolicyAgreed }) {
  const plaintext = runtimeFieldInputJson({ uid, jobToken, organizationId, organizationTags, dataPolicyAgreed })
  const uuid = reverseMaskUUID(crypto.randomBytes(16))
  const keyText = runtimeASCIIKey(uuid)
  const key = Buffer.from(keyText, 'ascii')
  const cipher = crypto.createCipheriv('aes-128-cbc', key, key)
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  const publicKey = crypto.createPublicKey({
    key: Buffer.from(RUNTIME_PUBLIC_KEY_B64, 'base64'),
    format: 'der',
    type: 'spki',
  })
  const encryptedKey = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, key)
  return { encryptUserInfo: b64(ciphertext), key: b64(encryptedKey) }
}

/** 稳定派生的会话 id（同一账号 + 同一模型始终同一个）。 */
export function sessionIdFor(seed) {
  const digest = crypto.createHash('sha256').update(String(seed), 'utf8').digest()
  return formatLowerUUID(digest.subarray(0, 16))
}

/** 纯计算自检；任何一条不成立都说明签名链路会 401。 */
export function selfCheck() {
  const probe = Buffer.from('0123456789abcdef', 'ascii')
  if (!swapOuterThirds(swapOuterThirds(probe)).equals(probe)) throw new Error('swapOuterThirds 不自反')
  if (swapOuterThirds(Buffer.from('abcdef', 'ascii')).toString('ascii') !== 'efcdab') {
    throw new Error('swapOuterThirds 结果不对')
  }
  const one = encodeBody(Buffer.from([0x66]))
  if (one.length !== 4 || one.toString('ascii').split('').filter(ch => ch === BODY_PAD).length !== 2) {
    throw new Error('自定义 base64 填充不对')
  }
  const three = encodeBody(Buffer.from('abc', 'ascii'))
  if (three.length !== 4 || three.toString('ascii').includes(BODY_PAD)) throw new Error('三字节不该有填充')
  const expected = md5Hex(`PAYLOAD\nKEY\n1700000000\nBODY\n${COSY_SIGNED_PATH}`)
  if (authorization('PAYLOAD', 'KEY', '1700000000', 'BODY') !== `Bearer COSY.PAYLOAD.${expected}`) {
    throw new Error('签名公式不对')
  }
  const listSig = authorization('PAYLOAD', 'KEY', '1700000000', '', MODEL_LIST_SIGNED_PATH)
  if (!listSig.endsWith(md5Hex(`PAYLOAD\nKEY\n1700000000\n\n${MODEL_LIST_SIGNED_PATH}`))) {
    throw new Error('目录签名路径未生效')
  }
  const masked = reverseMaskUUID(Buffer.from(Array.from({ length: 16 }, (_, i) => i + 1)))
  if ((masked[6] & 0xf0) !== 0x40 || (masked[8] & 0xc0) !== 0x80 || masked[0] !== 16) {
    throw new Error('UUID 掩码位不对')
  }
  const uuid = formatLowerUUID(masked)
  if (uuid.length !== 36 || runtimeASCIIKey(masked) !== uuid.replace(/-/g, '').slice(0, 16)) {
    throw new Error('AES key 派生不对')
  }
  const fields = generateRuntimeFields({
    uid: 'u-1', jobToken: 'jt-1', organizationId: 'org-1', organizationTags: ['t1', 't2'], dataPolicyAgreed: true,
  })
  const cipherBytes = Buffer.from(fields.encryptUserInfo, 'base64')
  if (cipherBytes.length % 16 !== 0) throw new Error('AES 密文未按块对齐')
  if (Buffer.from(fields.key, 'base64').length !== 128) throw new Error('RSA 密文不是 128 字节')
  if (!runtimeFieldInputJson({ uid: 'u', jobToken: 'jt', organizationId: '', organizationTags: [], dataPolicyAgreed: false }).includes('security_oauth_token')) {
    throw new Error('jobToken 非空时必须写进明文')
  }
  if (runtimeFieldInputJson({ uid: 'u', jobToken: '', organizationId: '', organizationTags: [], dataPolicyAgreed: false }).includes('security_oauth_token')) {
    throw new Error('jobToken 为空时必须省略该键')
  }
  return true
}
