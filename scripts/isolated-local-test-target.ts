/** Explicit opt-in for the disposable, loopback-only database used by CI. */
export function assertIsolatedLocalTestTarget(environment: NodeJS.ProcessEnv) {
  if (environment.SERVICEHUB_LOCAL_TEST_DATABASE !== '1' || environment.NODE_ENV !== 'test') {
    throw new Error('Local migration verification requires explicit test mode.');
  }
  const targets = ['DATABASE_URL', 'DIRECT_URL'].map(key => {
    const value = environment[key];
    if (!value) throw new Error(`${key} is required for local migration verification.`);
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.pathname !== '/servicehub_ci'
      || (url.searchParams.has('schema') && url.searchParams.get('schema') !== 'public')
      || url.searchParams.has('options')) {
      throw new Error('Local migration verification requires the loopback servicehub_ci database without a custom search path.');
    }
    return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
  });
  if (targets[0] !== targets[1]) {
    throw new Error('Local runtime and direct connections must target the same test database.');
  }
}
