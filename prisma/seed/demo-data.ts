import { v5 } from 'uuid';
import type { Prisma, StartMode } from '@prisma/client';

export const DEMO_PASSWORD = 'UrgentDemo!2026';
export const demoId = (key: string) => v5(key, 'd241ca29-5fe4-4bcb-b6cb-393420a87b23');
export const minutes = (date: Date, value: number) => new Date(date.getTime() + value * 60_000);

export const regions = [
  { name: 'Lagos', stateId: 'ng-lagos', lga: 'Lagos Mainland', lgaId: 'ng-lagos:lagos-mainland', area: 'Yaba', pickup: { lat: 6.5153, lng: 3.3792 }, destination: { lat: 6.5020, lng: 3.3610 } },
  { name: 'Federal Capital Territory', stateId: 'ng-fct', lga: 'Abuja Municipal Area Council', lgaId: 'ng-fct:abuja-municipal-area-council', area: 'Wuse', pickup: { lat: 9.0765, lng: 7.4680 }, destination: { lat: 9.0625, lng: 7.4750 } },
  { name: 'Oyo', stateId: 'ng-oyo', lga: 'Ibadan North', lgaId: 'ng-oyo:ibadan-north', area: 'Bodija', pickup: { lat: 7.4350, lng: 3.9120 }, destination: { lat: 7.4220, lng: 3.9050 } },
] as const;

const runnerNames = ['Tunde Adebayo', 'Chinedu Okafor', 'Aisha Bello', 'Kunle Adeyemi', 'Ngozi Eze', 'Seyi Balogun', 'Fatima Yusuf', 'Ibrahim Musa', 'Bola Akinola', 'Damilola Ajayi'];
const requesterNames = ['Ada Nwosu', 'Femi Ogunleye', 'Zainab Lawal', 'Emeka Obi', 'Bisola Adeola', 'Chiamaka Uche', 'Maryam Sani', 'David Audu', 'Funmi Oladele', 'Kemi Alabi'];

export const demoUsers = (['RUNNER', 'REQUESTER'] as const).flatMap((mode) =>
  (mode === 'RUNNER' ? runnerNames : requesterNames).map((name, index) => {
    const number = String(index + 1).padStart(2, '0');
    return {
      id: demoId(`${mode}:${number}`), name, mode: mode as StartMode, index,
      email: `${mode.toLowerCase()}${number}@demo.urgent.test`,
      phone: `+2348000000${mode === 'RUNNER' ? '1' : '2'}${number}`,
      region: regions[index < 6 ? 0 : index < 8 ? 1 : 2],
    };
  }),
);

export const demoRunners = demoUsers.filter((user) => user.mode === 'RUNNER');
export const demoRequesters = demoUsers.filter((user) => user.mode === 'REQUESTER');
export type DemoUser = (typeof demoUsers)[number];
export type DemoContext = { tx: Prisma.TransactionClient; now: Date; passwordHash: string };

/** Keep matches inside each state; historical jobs rotate partners to give everyone reviews. */
export function runnerFor(requester: DemoUser, offset = 0): DemoUser {
  const pool = demoRunners.filter((runner) => runner.region.stateId === requester.region.stateId);
  return pool[(pool.findIndex((runner) => runner.index === requester.index) + offset) % pool.length];
}

export const errandId = (requester: DemoUser, scenario: string) => demoId(`errand:${requester.index}:${scenario}`);
export const completedScenarios = ['completed-1', 'completed-2', 'completed-3', 'completed-unreviewed'] as const;

export function activeScenario(index: number) {
  return (['ACCEPTED', 'IN_PROGRESS', 'PICKED_UP', 'DELIVERED'] as const)[index % 4];
}
