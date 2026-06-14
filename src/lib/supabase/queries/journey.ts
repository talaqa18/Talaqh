// Journey query — the unit list for الرحلة.
// ----------------------------------------------------------------------------
// Returns every PUBLISHED unit (ordered by position) joined to the caller's
// own unit_progress row, projected to a per-card { unit, status, resume } shape
// the journey screen renders directly. Status defaults to "locked" when there
// is no progress row; the earliest in_progress unit is the user's CURRENT unit.

import { supabase } from "../client";
import type { ProgressStatus, UnitRow, UnitSection } from "../types";

/** Where the user stopped inside a unit (UI resume pointer; never a gate). */
export interface UnitResume {
  section: UnitSection | null;
  wordPosition: number | null;
  subScreen: string | null;
  updatedAt: string | null;
}

/** One unit card on the journey screen. */
export interface JourneyCard {
  unit: UnitRow;
  status: ProgressStatus;
  resume: UnitResume | null;
}

// The subset of unit_progress we read for the journey. resume_* columns are
// additive (0008) and not in the hand-written Row type, so we select them
// explicitly and type the shape here.
interface ProgressLite {
  unit_id: string;
  status: ProgressStatus;
  resume_section: UnitSection | null;
  resume_word_position: number | null;
  resume_sub_screen: string | null;
  resume_updated_at: string | null;
}

/**
 * Load all published units (by position) with the caller's progress folded in.
 * Two cheap reads (units + the user's progress rows) joined in memory keeps the
 * RLS-safe shape simple and avoids leaking other users' progress.
 */
export async function getJourney(): Promise<JourneyCard[]> {
  const [unitsRes, progressRes] = await Promise.all([
    supabase
      .from("units")
      .select("*")
      .eq("status", "published")
      .order("position", { ascending: true }),
    supabase
      .from("unit_progress")
      .select(
        "unit_id, status, resume_section, resume_word_position, resume_sub_screen, resume_updated_at",
      ),
  ]);

  if (unitsRes.error) throw unitsRes.error;
  if (progressRes.error) throw progressRes.error;

  const units = unitsRes.data ?? [];
  const progressRows = (progressRes.data ?? []) as unknown as ProgressLite[];
  const byUnit = new Map<string, ProgressLite>(
    progressRows.map((row) => [row.unit_id, row]),
  );

  return units.map((unit) => {
    const progress = byUnit.get(unit.id);
    const status: ProgressStatus = progress?.status ?? "locked";

    const resume: UnitResume | null = progress
      ? {
          section: progress.resume_section,
          wordPosition: progress.resume_word_position,
          subScreen: progress.resume_sub_screen,
          updatedAt: progress.resume_updated_at,
        }
      : null;

    return { unit, status, resume };
  });
}
