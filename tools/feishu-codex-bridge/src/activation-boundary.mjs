export function isNewDispatchMessage(message, activationFromMs) {
  const createdAt = Number(message?.createTime);
  return Number.isSafeInteger(activationFromMs) && activationFromMs > 0 &&
    Number.isSafeInteger(createdAt) && createdAt >= activationFromMs;
}
