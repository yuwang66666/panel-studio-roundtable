import { create } from 'zustand';
import { PublicEventSchema, SnapshotSchema, type DiscussionSnapshot } from '@panel/contracts';
import { projectEvent } from '../../../packages/domain/src/events';
import { request } from './api';
type Network = 'connecting' | 'connected' | 'reconnecting';
interface LiveState {
  snapshots: Record<string, DiscussionSnapshot>;
  network: Record<string, Network>;
  initialize: (s: DiscussionSnapshot, force?: boolean) => void;
  state: (id: string, state: Network) => void;
  event: (id: string, data: unknown) => boolean;
}
export const useLive = create<LiveState>((set, get) => ({
  snapshots: {},
  network: {},
  initialize: (s, force = false) =>
    set((state) => {
      const current = state.snapshots[s.discussion.id];
      return current && !force && current.lastEventSeq > s.lastEventSeq
        ? state
        : { snapshots: { ...state.snapshots, [s.discussion.id]: SnapshotSchema.parse(s) } };
    }),
  state: (id, network) => set((state) => ({ network: { ...state.network, [id]: network } })),
  event: (id, data) => {
    const current = get().snapshots[id];
    if (!current) return false;
    const e = PublicEventSchema.safeParse(data);
    if (!e.success) return false;
    const next = projectEvent(current, e.data);
    if (!next) return false;
    if (next !== current) set((state) => ({ snapshots: { ...state.snapshots, [id]: next } }));
    return true;
  },
}));
const subscriptions = new Map<string, { refs: number; close: () => void }>();
export function subscribe(id: string) {
  const existing = subscriptions.get(id);
  if (existing) {
    existing.refs++;
    return () => release(id);
  }
  let source: EventSource | undefined,
    closed = false,
    resyncing = false;
  const open = () => {
    if (closed) return;
    const cursor = useLive.getState().snapshots[id]?.lastEventSeq || 0;
    source = new EventSource(`/api/discussions/${id}/events?after=${cursor}`);
    useLive.getState().state(id, 'connecting');
    source.onopen = () => useLive.getState().state(id, 'connected');
    source.onerror = () => useLive.getState().state(id, 'reconnecting');
    source.addEventListener('reset', () => {
      void resync();
    });
    source.addEventListener('panel', (event) => {
      try {
        if (!useLive.getState().event(id, JSON.parse((event as MessageEvent).data))) void resync();
      } catch {
        void resync();
      }
    });
  };
  const resync = async () => {
    if (closed || resyncing) return;
    resyncing = true;
    source?.close();
    useLive.getState().state(id, 'reconnecting');
    try {
      const snapshot = await request<DiscussionSnapshot>(`/discussions/${id}/snapshot`);
      if (!closed) useLive.getState().initialize(snapshot, true);
    } catch {
      if (!closed) useLive.getState().state(id, 'reconnecting');
    } finally {
      resyncing = false;
      if (!closed) open();
    }
  };
  const item = {
    refs: 1,
    close: () => {
      closed = true;
      source?.close();
    },
  };
  subscriptions.set(id, item);
  open();
  return () => release(id);
}
function release(id: string) {
  const item = subscriptions.get(id);
  if (item && --item.refs === 0) {
    item.close();
    subscriptions.delete(id);
  }
}
