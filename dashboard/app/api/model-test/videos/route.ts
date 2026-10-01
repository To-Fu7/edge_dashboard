import { NextResponse } from 'next/server';
import fs from 'fs';
import { PYTHON_COUNTING_DIR } from '@/lib/compose';
import path from 'path';

export const dynamic = 'force-dynamic';

const VIDEO_EXTS = new Set(['.mp4', '.avi', '.mkv']);
const TEST_VIDEOS_DIR = path.join(PYTHON_COUNTING_DIR, 'test-videos');

// Lists video files dropped into python-counting/test-videos/ so the Model
// Test page can offer a dropdown instead of a free-text path.
export async function GET() {
  try {
    if (!fs.existsSync(TEST_VIDEOS_DIR)) {
      return NextResponse.json({ videos: [] });
    }
    const videos = fs.readdirSync(TEST_VIDEOS_DIR)
      .filter(f => VIDEO_EXTS.has(path.extname(f).toLowerCase()));
    return NextResponse.json({ videos });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
