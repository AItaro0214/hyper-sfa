// 入力の検証。誤りを集めて、最後に validation エラー（details 付き）として投げる。
import { validation } from './errors.js';

export class Check {
  constructor() {
    this.details = [];
  }

  fail(field, message) {
    this.details.push({ field, message });
  }

  // 文字列。前後の空白を取って返す。required でなければ未指定は ''
  str(value, field, { required = false, min = 0, max = 1000, pattern = null, label = field } = {}) {
    if (value === undefined || value === null) value = '';
    if (typeof value !== 'string') {
      this.fail(field, `${label}は文字列で入力してください`);
      return '';
    }
    const v = value.trim();
    if (required && v === '') this.fail(field, `${label}を入力してください`);
    else if (v !== '' && v.length < min) this.fail(field, `${label}は${min}文字以上にしてください`);
    if (v.length > max) this.fail(field, `${label}は${max}文字以内にしてください`);
    if (v !== '' && pattern && !pattern.test(v)) this.fail(field, `${label}の形式が正しくありません`);
    return v;
  }

  // 文字列の配列。空要素は捨てる
  strList(value, field, { maxItems = 10, maxLen = 200, label = field } = {}) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      this.fail(field, `${label}は配列で指定してください`);
      return [];
    }
    if (value.length > maxItems) this.fail(field, `${label}は${maxItems}件までです`);
    const out = [];
    for (const item of value.slice(0, maxItems)) {
      if (typeof item !== 'string') {
        this.fail(field, `${label}は文字列の配列にしてください`);
        return [];
      }
      const v = item.trim();
      if (v.length > maxLen) this.fail(field, `${label}の各項目は${maxLen}文字以内にしてください`);
      if (v) out.push(v);
    }
    return out;
  }

  oneOf(value, allowed, field, label = field) {
    if (!allowed.includes(value)) {
      this.fail(field, `${label}が正しくありません`);
      return null;
    }
    return value;
  }

  done() {
    if (this.details.length) throw validation(this.details);
  }
}

// 本文の JSON を読む。壊れていれば validation にする（500 にしない）
export async function readJson(c) {
  try {
    const body = await c.req.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('not an object');
    }
    return body;
  } catch {
    throw validation([{ field: 'body', message: 'JSON の形式が正しくありません' }]);
  }
}

// 本文が空でもよい POST 用
export async function readJsonOptional(c) {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    const body = JSON.parse(text);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch {
    throw validation([{ field: 'body', message: 'JSON の形式が正しくありません' }]);
  }
}
