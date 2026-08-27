export type ChatSubmitErrorCode = 'INVALID_MESSAGE' | 'PROFILE_NOT_FOUND' | 'RUNTIME_UNAVAILABLE';

export type ChatSubmitAck =
  | { ok: true; accepted: true }
  | {
      ok: false;
      accepted: false;
      error: { code: ChatSubmitErrorCode; message: string };
    };

const CHAT_SUBMIT_ERROR_MESSAGES: Record<ChatSubmitErrorCode, string> = {
  INVALID_MESSAGE: '消息不能为空，请输入内容后重试。',
  PROFILE_NOT_FOUND: '当前伙伴不存在或已被删除，请重新选择伙伴。',
  RUNTIME_UNAVAILABLE: '伙伴运行时暂不可用，请检查 AI Agent 配置后重试。',
};

export function rejectChatSubmit(code: ChatSubmitErrorCode): ChatSubmitAck {
  return {
    ok: false,
    accepted: false,
    error: { code, message: CHAT_SUBMIT_ERROR_MESSAGES[code] },
  };
}

export function acceptChatSubmit(): ChatSubmitAck {
  return { ok: true, accepted: true };
}
