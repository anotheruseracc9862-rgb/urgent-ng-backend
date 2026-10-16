import { all } from 'nigerian-states-and-lgas/lib/src/index.js';

const slug = (name: string) => name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const matchKey = (name: string) => name.toLowerCase().replace(/\s+(state|local government area|lga)$/i, '').replace(/[^a-z0-9]/g, '');

/** Pinned reference names, not geographic boundary polygons. IDs are country/state scoped. */
export const SERVICE_STATES = all().map((entry) => {
  // Upstream 1.0.8 spells Katsina as "Kastina".
  const name = entry.state === 'Kastina' ? 'Katsina' : entry.state;
  const id = name === 'Federal Capital Territory' ? 'ng-fct' : `ng-${slug(name)}`;
  return {
    id,
    name,
    lgas: entry.lgas.map((lga) => ({ id: `${id}:${slug(lga)}`, name: lga })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}).sort((a, b) => a.name.localeCompare(b.name));

export function resolveState(name?: string | null) {
  if (!name) return undefined;
  const key = matchKey(name);
  if (['fct', 'abuja', 'abujafct', 'federalcapitalterritory'].includes(key)) return SERVICE_STATES.find((state) => state.id === 'ng-fct');
  return SERVICE_STATES.find((state) => state.id === name || matchKey(state.name) === key);
}

export function resolveLga(stateId: string, name?: string | null) {
  if (!name) return undefined;
  const key = matchKey(name);
  return SERVICE_STATES.find((state) => state.id === stateId)?.lgas.find((lga) => lga.id === name || matchKey(lga.name) === key);
}
