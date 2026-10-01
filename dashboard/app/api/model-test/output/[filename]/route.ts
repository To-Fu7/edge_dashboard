import { PYTHON_COUNTING_DIR } from '@/lib/compose';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

const SAFE_FILENAME = /^[a-zA-Z0-9._-]+\.mp4$/;

// Serves a finished model-test recording for the <video> player. Range-aware
// so scrubbing/seeking in the browser works instead of always fetching the
// whole file from byte 0.
export async function GET(request: Request, { params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params;
  if (!SAFE_FILENAME.test(filename)) {
    return new Response('invalid filename', { status: 400 });
  }

  const filePath = path.join(PYTHON_COUNTING_DIR, 'recordings', filename);
  if (!fs.existsSync(filePath)) {
    return new Response('not found', { status: 404 });
  }

  const stat = fs.statSync(filePath);
  const range = request.headers.get('range');

  if (!range) {
    return new Response(fs.readFileSync(filePath), {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(stat.size),
        'Accept-Ranges': 'bytes',
      },
    });
  }

  const match = range.match(/bytes=(\d+)-(\d*)/);
  const start = match ? parseInt(match[1], 10) : 0;
  const end = match && match[2] ? parseInt(match[2], 10) : stat.size - 1;
  const chunk = fs.readFileSync(filePath).subarray(start, end + 1);

  return new Response(chunk, {
    status: 206,
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': String(chunk.length),
      'Accept-Ranges': 'bytes',
    },
  });
}
