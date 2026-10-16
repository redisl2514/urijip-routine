import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Share } from '@capacitor/share';

const DAY_MS = 24 * 60 * 60 * 1000;
const HORIZON_DAYS = 370;
const MAX_NOTIFICATIONS = 400;
const isNative = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
const localDate = (value) => new Date(`${value}T00:00:00`);
const iso = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

function occursOn(event, date) {
  const base = localDate(event.date);
  if (date < base) return false;
  const repeat = event.repeat || 'none';
  if (repeat === 'none') return date.getTime() === base.getTime();
  if (repeat === 'weekly') return Math.round((date - base) / DAY_MS) % 7 === 0;
  if (repeat === 'monthly') {
    const months = (date.getFullYear() - base.getFullYear()) * 12 + date.getMonth() - base.getMonth();
    return months >= 0 && date.getDate() === Math.min(base.getDate(), new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate());
  }
  if (repeat === 'yearly') {
    const last = new Date(date.getFullYear(), base.getMonth() + 1, 0).getDate();
    return date.getMonth() === base.getMonth() && date.getDate() === Math.min(base.getDate(), last);
  }
  return false;
}

function stableId(key, used) {
  let hash = 2166136261;
  for (const char of key) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  let id = (hash >>> 0) & 0x7fffffff;
  while (used.has(id)) id = id === 0x7fffffff ? 1 : id + 1;
  used.add(id);
  return id;
}

function upcomingNotifications(data) {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + HORIZON_DAYS);
  const entries = [];
  const add = (key, title, body) => {
    const at = new Date(`${key}T09:00:00`);
    if (at > now && at <= end) entries.push({ key, title, body, at });
  };

  for (const event of data.events || []) {
    const reminderDays = Math.max(0, Number(event.reminder) || 0);
    const start = localDate(event.date);
    const cursor = new Date(start < now ? now : start);
    cursor.setHours(0, 0, 0, 0);
    for (let i = 0; i <= HORIZON_DAYS; i++) {
      const occurrence = new Date(cursor);
      occurrence.setDate(cursor.getDate() + i);
      if (!occursOn(event, occurrence)) continue;
      const alertDate = new Date(occurrence);
      alertDate.setDate(alertDate.getDate() - reminderDays);
      const dateKey = iso(occurrence);
      const when = reminderDays === 0 ? '오늘' : `${reminderDays}일 후`;
      add(iso(alertDate), '우리집 루틴 일정 알림', `${event.title} 일정이 ${when} 있어요. (${dateKey})`);
    }
  }

  for (const filter of data.filters || []) {
    const reminderDays = Math.max(0, Number(filter.reminder) || 0);
    const due = localDate(filter.next);
    for (let i = 0; i < HORIZON_DAYS && due <= end; i++) {
      const alertDate = new Date(due);
      alertDate.setDate(alertDate.getDate() - reminderDays);
      const when = reminderDays === 0 ? '오늘' : `${reminderDays}일 후`;
      add(iso(alertDate), '우리집 루틴 필터 알림', `${filter.name} 교체가 ${when} 예정이에요. (${iso(due)})`);
      due.setDate(due.getDate() + Math.max(1, Number(filter.period) || HORIZON_DAYS));
    }
  }

  return entries.sort((a, b) => a.at - b.at).slice(0, MAX_NOTIFICATIONS);
}

async function sync(data) {
  if (!isNative()) return;
  const permissions = await LocalNotifications.checkPermissions();
  if (permissions.display !== 'granted') return;
  const pending = await LocalNotifications.getPending();
  if (pending.notifications.length) {
    await LocalNotifications.cancel({ notifications: pending.notifications.map(({ id }) => ({ id })) });
  }
  const used = new Set();
  const notifications = upcomingNotifications(data).map((item) => ({
    id: stableId(item.key + item.title + item.body, used),
    title: item.title,
    body: item.body,
    schedule: { at: item.at },
    isExactNotification: false,
  }));
  if (notifications.length) await LocalNotifications.schedule({ notifications });
}

window.UrijipNativeNotifications = {
  isNative,
  async enable(data) {
    if (!isNative()) return { ok: false, reason: 'not-native' };
    let permission = await LocalNotifications.checkPermissions();
    if (permission.display !== 'granted') permission = await LocalNotifications.requestPermissions();
    if (permission.display !== 'granted') return { ok: false, reason: 'denied' };
    await sync(data);
    return { ok: true };
  },
  sync,
  async test() {
    if (!isNative()) return { ok: false, reason: 'not-native' };
    const permission = await LocalNotifications.checkPermissions();
    if (permission.display !== 'granted') return { ok: false, reason: 'denied' };
    await LocalNotifications.schedule({ notifications: [{ id: 2147483000, title: '우리집 루틴 테스트 알림', body: '휴대폰 알림이 정상적으로 설정됐어요.', schedule: { at: new Date(Date.now() + 5000) }, isExactNotification: false }] });
    return { ok: true };
  },
};

document.addEventListener('DOMContentLoaded', () => {
  if (!isNative()) return;
  const backupButton = document.getElementById('backupButton');
  backupButton?.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      const data = JSON.parse(localStorage.getItem('urijip-routine-v1') || '{"events":[],"filters":[]}');
      const backup = {
        format: 'urijip-routine-backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        data: {
          events: Array.isArray(data.events) ? data.events : [],
          filters: Array.isArray(data.filters) ? data.filters : [],
        },
        photo: localStorage.getItem('urijip-home-photo-v1'),
      };
      const filename = `urijip-routine-backup-${new Date().toISOString().slice(0, 10)}.json`;
      const file = await Filesystem.writeFile({
        path: filename,
        data: JSON.stringify(backup, null, 2),
        directory: Directory.Cache,
        encoding: Encoding.UTF8,
      });
      await Share.share({
        title: '우리집 루틴 백업',
        text: '백업 파일을 저장할 앱을 선택해 주세요.',
        url: file.uri,
        dialogTitle: '백업 파일 저장',
      });
    } catch (error) {
      if (error?.message?.toLowerCase().includes('cancel')) return;
      alert('백업 파일을 준비하지 못했어요. 저장 공간을 확인한 뒤 다시 시도해 주세요.');
    }
  }, true);
  const status = document.getElementById('nativeNotificationStatus');
  const enable = document.getElementById('enableNativeNotifications');
  const test = document.getElementById('testNativeNotification');
  const getData = () => {
    try { return JSON.parse(localStorage.getItem('urijip-routine-v1') || '{"events":[],"filters":[]}'); }
    catch { return { events: [], filters: [] }; }
  };
  const updateStatus = async () => {
    const permission = await LocalNotifications.checkPermissions();
    status.textContent = permission.display === 'granted' ? '알림이 켜져 있어요. 일정과 필터가 기기 안에서 예약됩니다.' : '알림을 켜면 일정과 필터 알림을 이 휴대폰에서 받을 수 있어요.';
  };
  enable.addEventListener('click', async () => {
    try {
      const result = await window.UrijipNativeNotifications.enable(getData());
      if (!result.ok) throw new Error(result.reason);
      status.textContent = '알림이 켜져 있어요. 일정과 필터가 기기 안에서 예약됩니다.';
      alert('휴대폰 알림을 켰어요. 저장된 일정과 필터를 예약했습니다.');
    } catch {
      alert('알림을 켜지 못했어요. 휴대폰 설정에서 우리집 루틴의 알림 권한을 허용해 주세요.');
      updateStatus();
    }
  });
  test.addEventListener('click', async () => {
    try {
      const result = await window.UrijipNativeNotifications.test();
      if (!result.ok) throw new Error(result.reason);
      alert('5초 뒤 테스트 알림이 도착합니다.');
    } catch {
      alert('먼저 “알림 켜기”를 눌러 알림 권한을 허용해 주세요.');
    }
  });
  updateStatus();
  sync(getData()).catch(() => {});
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(getData()).catch(() => {}); });
});
