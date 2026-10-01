// Runs a long-lived build command (docker build / docker compose run) and
// streams its stdout+stderr to the HTTP response as it's produced, instead of
// buffering the whole thing like execAsync does. Builds (ONNX export, engine
// build, camera image build) can run for many minutes — without this, the
// browser just shows a spinner with no feedback until the whole thing ends.
import { spawn, ChildProcess } from 'child_process';

export interface StreamCommand {
  cmd: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

/** Runs `steps` in sequence, streaming each line prefixed with a step marker.
 *  Stops at the first failing step. Returns a ReadableStream<Uint8Array> of
 *  plain text suitable as a Next.js Route Handler Response body. */
export function streamSteps(steps: { label: string; command: StreamCommand }[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let currentChild: ChildProcess | null = null;
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (line: string) => {
        try { controller.enqueue(encoder.encode(line)); } catch { /* already closed */ }
      };

      for (const [i, step] of steps.entries()) {
        if (cancelled) return;
        write(`\n─── [${i + 1}/${steps.length}] ${step.label} ───\n`);

        const exitCode = await new Promise<number>((resolve) => {
          const child = spawn(step.command.cmd, step.command.args, {
            cwd: step.command.cwd,
            env: { ...process.env, ...step.command.env },
          });
          currentChild = child;

          child.stdout.on('data', (chunk: Buffer) => write(chunk.toString()));
          child.stderr.on('data', (chunk: Buffer) => write(chunk.toString()));
          child.on('error', (err) => {
            write(`\n[error] failed to start: ${err.message}\n`);
            resolve(1);
          });
          child.on('close', (code) => resolve(code ?? 1));
        });
        currentChild = null;

        if (cancelled) return;
        if (exitCode !== 0) {
          write(`\n✗ "${step.label}" failed (exit ${exitCode})\n`);
          controller.close();
          return;
        }
        write(`\n✓ "${step.label}" done\n`);
      }

      write(`\n✔ all steps complete\n`);
      controller.close();
    },
    // Fires when the consumer stops reading (e.g. the browser aborted the
    // fetch) — without this, a "Stop" button only stops updating the UI while
    // the spawned docker process (a build, or a model-test run against a long
    // video) keeps running unattended on the server.
    cancel() {
      cancelled = true;
      currentChild?.kill('SIGTERM');
    },
  });
}

export function streamResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
