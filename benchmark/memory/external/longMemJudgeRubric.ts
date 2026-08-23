/** BUG-MEM-18 · LongMemEval 官方 QA Judge rubric 的 OpenAI-compatible 版本。 */
export const LONGMEMEVAL_JUDGE_SYSTEM_PROMPT = 'Return yes or no only.';

export function longMemEvalJudgePrompt(
  category: string,
  question: string,
  answer: string,
  response: string,
  abstention: boolean,
): string {
  if (abstention) {
    return [
      'I will give you an unanswerable question, an explanation, and a response from a model.',
      'Answer yes if the model correctly identifies the question as unanswerable. The model may say that the information is incomplete, or give other information while making clear that the asked information is unavailable.',
      `Question: ${question}`,
      `Explanation: ${answer}`,
      `Model Response: ${response}`,
      'Does the model correctly identify the question as unanswerable? Answer yes or no only.',
    ].join('\n\n');
  }

  if (category === 'single-session-preference') {
    return [
      'I will give you a question, a rubric for a desired personalized response, and a response from a model.',
      'Answer yes if the response satisfies the desired response. The model need not reflect every rubric point; it is correct when it recalls and uses the relevant personal information correctly.',
      `Question: ${question}`,
      `Rubric: ${answer}`,
      `Model Response: ${response}`,
      'Is the model response correct? Answer yes or no only.',
    ].join('\n\n');
  }

  const instructions = category === 'temporal-reasoning'
    ? 'Equivalent wording and complete intermediate reasoning are acceptable. A response containing only part of a multi-part answer is not. For a requested number of days, weeks, months, or another duration, do not penalize an off-by-one error.'
    : category === 'knowledge-update'
      ? 'Answer yes when the response contains the required updated answer. If it also contains previous information, it remains correct as long as the updated answer is present.'
      : 'Equivalent wording and complete intermediate reasoning are acceptable. A response containing only part of the information required by the answer is not correct.';
  return [
    'I will give you a question, a correct answer, and a response from a model.',
    `Answer yes if the response contains the correct answer; otherwise answer no. ${instructions}`,
    `Question: ${question}`,
    `Correct Answer: ${answer}`,
    `Model Response: ${response}`,
    'Is the model response correct? Answer yes or no only.',
  ].join('\n\n');
}
