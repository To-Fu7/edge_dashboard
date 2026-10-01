// Shared between /api/model-test/run (spawns the container) and
// /api/model-test/stream (proxies its live MJPEG preview) so the two never
// drift out of sync on the container name / port they both depend on.
export const CAMERA_IMAGE = 'python-counting-services-python-1:latest';
// Fixed name so the dashboard can proxy the live preview by container name on
// the shared "envisions" network (same DNS mechanism as `triton:8001`). Only
// one test can usefully run at a time anyway (one live-preview viewer).
export const RUNNER_NAME = 'model-test-runner';
export const STREAM_PORT = 8099;
