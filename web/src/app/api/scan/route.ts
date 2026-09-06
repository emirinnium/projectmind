import { NextResponse } from 'next/server';
import { runScanJson } from '../../../lib/report-cli';

export async function POST() {
  try {
    return NextResponse.json({ success: true, ...(await runScanJson()) });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Scan failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
