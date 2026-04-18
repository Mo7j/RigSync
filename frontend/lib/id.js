export function createId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  const randomChunk = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  const timestamp = Date.now().toString(16);

  return [
    timestamp,
    randomChunk(),
    randomChunk(),
    randomChunk(),
    `${randomChunk()}${randomChunk()}${randomChunk()}`,
  ].join("-");
}
