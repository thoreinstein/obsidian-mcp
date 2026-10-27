/** Another process (a CLI hook) can commit to the same table; LanceDB reports that as a retryable conflict. */
export async function withCommitRetry<T>(
  fn: () => Promise<T>,
  attempts = 5,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise(r => setTimeout(r, ms))
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const conflict = String((err as Error)?.message ?? err).includes('Retryable commit conflict');
      if (!conflict || i >= attempts - 1) throw err;
      await sleep(25 * 2 ** i + Math.random() * 25);
    }
  }
}
