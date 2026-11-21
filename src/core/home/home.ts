/**
 * The dashboard home: what a signed-in person sees first. Their recent Conversations, the
 * Report Runs coming up, the KPI Alerts currently firing and the KPIs' current values.
 */
import type { Conversation, Conversations } from '../conversations/conversations';
import { isFiring, type Kpi, type KpiAlert, type Kpis } from '../kpis/kpis';
import type { Report, Reports } from '../reports/reports';

/** An active Report, which always has a next Report Run. */
export type UpcomingRun = Report & { nextRunAt: Date };

export interface HomeOverview {
  /** Conversations the person is a Participant of, newest first. */
  recentConversations: Conversation[];
  /** Active Reports by their next Report Run, soonest first. */
  upcomingRuns: UpcomingRun[];
  /** Active KPI Alerts whose condition held at their last check, most recently fired first. */
  firingAlerts: (KpiAlert & { kpi: Kpi })[];
  /** Approved KPIs (active or paused) with their current value, by name. */
  kpis: Kpi[];
}

export interface Home {
  overview(actorSlackUserId: string): Promise<HomeOverview>;
}

/** How many of each list the home shows; the full lists have their own pages. */
const RECENT_CONVERSATIONS = 5;
const UPCOMING_RUNS = 5;

export function createHome({
  conversations,
  reports,
  kpis,
}: {
  conversations: Conversations;
  reports: Reports;
  kpis: Kpis;
}): Home {
  async function upcomingRuns(actor: string): Promise<UpcomingRun[]> {
    return (await reports.list(actor))
      .filter((r): r is UpcomingRun => r.status === 'active' && r.nextRunAt !== null)
      .sort((a, b) => a.nextRunAt.getTime() - b.nextRunAt.getTime())
      .slice(0, UPCOMING_RUNS);
  }

  async function kpisAndAlerts(actor: string): Promise<Pick<HomeOverview, 'firingAlerts' | 'kpis'>> {
    const [allKpis, alerts] = await Promise.all([kpis.list(actor), kpis.listAlerts(actor)]);
    const byId = new Map(allKpis.map((k) => [k.id, k]));
    const firingAlerts = alerts
      .flatMap((alert) => {
        const kpi = byId.get(alert.kpiId);
        return isFiring(alert) && kpi ? [{ ...alert, kpi }] : [];
      })
      .sort((a, b) => (b.firedAt?.getTime() ?? 0) - (a.firedAt?.getTime() ?? 0));
    const approved = allKpis.filter((k) => k.status !== 'draft').sort((a, b) => a.name.localeCompare(b.name));
    return { firingAlerts, kpis: approved };
  }

  return {
    async overview(actor) {
      const [recentConversations, runs, kpiOverview] = await Promise.all([
        conversations.list(actor, { limit: RECENT_CONVERSATIONS }),
        upcomingRuns(actor),
        kpisAndAlerts(actor),
      ]);
      return { recentConversations, upcomingRuns: runs, ...kpiOverview };
    },
  };
}
