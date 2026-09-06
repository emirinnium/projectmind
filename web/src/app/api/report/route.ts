import { NextResponse } from 'next/server';
import { loadReportJson } from '../../../lib/report-cli';

export async function GET() {
  try {
    return NextResponse.json(await loadReportJson());
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Report failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
