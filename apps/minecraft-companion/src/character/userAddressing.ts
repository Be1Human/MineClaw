const GENERIC_USER_LABEL = /^(?:朋友|老朋友|好友|玩家|用户|对方|friend|player|user)$/i;
const GENERIC_VOCATIVE = /^(?:(?:嗨|嘿|喂)[，,、：:\s]*)?(?:朋友|老朋友|好友|玩家|用户|对方)[，,、：:！!\s]+/u;

export function isGenericUserLabel(value: string | undefined): boolean {
  return !!value?.trim() && GENERIC_USER_LABEL.test(value.trim());
}

export function explicitUserName(value: string | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized && !isGenericUserLabel(normalized) ? normalized : null;
}

/** Remove only a leading generic vocative; relationship wording in the body is preserved. */
export function stripGenericUserVocative(text: string): string {
  return text.replace(GENERIC_VOCATIVE, '').trimStart();
}
