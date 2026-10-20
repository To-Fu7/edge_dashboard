// Runs once when the Next.js server starts. Startup work (migrations, default
// users, container reconcile) lives in lib/startup.ts and runs in the
// background, so a database that is still booting doesn't block the server.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { runStartup } = await import('./lib/startup');
    void runStartup();
  }
}
