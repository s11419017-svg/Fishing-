import {
  createInitialSaveData,
  FISH_SPECIES,
  LINES,
  LURES,
  QUESTS,
  REELS,
  RODS,
  WATER_ZONES,
} from '../data/gameData';
import {
  CaughtFishInstance,
  FishSpecies,
  RarityTier,
  SaveSlotData,
  SpeciesCatchStats,
  TimeOfDay,
  WaterZoneId,
  WeatherType,
} from '../types/game';

const STORAGE_PREFIX = 'emerald_mirror_save_v1_slot_';
const ACTIVE_SLOT_KEY = 'emerald_mirror_active_slot_v1';
const SAVE_VERSION_PREFIX = 'EMV2:';
const MAX_IMPORT_LENGTH = 16384;

const VALID_ZONE_IDS = new Set<WaterZoneId>(WATER_ZONES.map((z) => z.id));
const VALID_ROD_IDS = new Set<string>(RODS.map((r) => r.id));
const VALID_REEL_IDS = new Set<string>(REELS.map((r) => r.id));
const VALID_LINE_IDS = new Set<string>(LINES.map((l) => l.id));
const VALID_LURE_IDS = new Set<string>(LURES.map((l) => l.id));
const VALID_SPECIES_IDS = new Set<string>(FISH_SPECIES.map((f) => f.id));
const VALID_GUARDIAN_IDS = new Set<string>(
  FISH_SPECIES.filter((f) => f.isGuardian).map((f) => f.id),
);
const VALID_QUEST_IDS = new Set<string>(QUESTS.map((q) => q.id));
const VALID_TIMES = new Set<TimeOfDay>(['dawn', 'dusk', 'night']);
const VALID_WEATHERS = new Set<WeatherType>(['clear', 'rain', 'mist']);

function clampFiniteInt(val: unknown, fallback: number, min: number, max: number): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(val)));
}

function clampFiniteFloat(val: unknown, fallback: number, min: number, max: number): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) return fallback;
  return Math.min(max, Math.max(min, Number(val.toFixed(2))));
}

function sanitizeIdList<T extends string>(
  raw: unknown,
  validSet: Set<T>,
  mandatoryDefault?: T,
): T[] {
  const result: T[] = [];
  const seen = new Set<T>();
  if (mandatoryDefault && validSet.has(mandatoryDefault)) {
    result.push(mandatoryDefault);
    seen.add(mandatoryDefault);
  }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string' && validSet.has(item as T) && !seen.has(item as T)) {
        seen.add(item as T);
        result.push(item as T);
      }
    }
  }
  return result;
}

/**
 * Strict schema & whitelist sanitizer to prevent prototype pollution (__proto__),
 * NaN/Infinity currency corruption, or invalid equipment/species ID crashes.
 */
export function sanitizeSaveData(raw: unknown, slotId: number): SaveSlotData {
  const validSlot = [1, 2, 3].includes(slotId) ? slotId : 1;
  const base = createInitialSaveData(validSlot);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return base;
  }

  const rec = raw as Record<string, unknown>;

  const unlockedZones = sanitizeIdList<WaterZoneId>(
    rec.unlockedZones,
    VALID_ZONE_IDS,
    'alpine_lake',
  );
  const ownedRods = sanitizeIdList<string>(rec.ownedRods, VALID_ROD_IDS, 'rod_ash');
  const ownedReels = sanitizeIdList<string>(rec.ownedReels, VALID_REEL_IDS, 'reel_bronze');
  const ownedLines = sanitizeIdList<string>(rec.ownedLines, VALID_LINE_IDS, 'line_linen');
  const ownedLures = sanitizeIdList<string>(rec.ownedLures, VALID_LURE_IDS, 'fly_feather');

  const currentZoneId =
    typeof rec.currentZoneId === 'string' &&
    unlockedZones.includes(rec.currentZoneId as WaterZoneId)
      ? (rec.currentZoneId as WaterZoneId)
      : unlockedZones[0];

  const equippedRodId =
    typeof rec.equippedRodId === 'string' && ownedRods.includes(rec.equippedRodId)
      ? rec.equippedRodId
      : ownedRods[0];
  const equippedReelId =
    typeof rec.equippedReelId === 'string' && ownedReels.includes(rec.equippedReelId)
      ? rec.equippedReelId
      : ownedReels[0];
  const equippedLineId =
    typeof rec.equippedLineId === 'string' && ownedLines.includes(rec.equippedLineId)
      ? rec.equippedLineId
      : ownedLines[0];
  const equippedLureId =
    typeof rec.equippedLureId === 'string' && ownedLures.includes(rec.equippedLureId)
      ? rec.equippedLureId
      : ownedLures[0];

  const timeOfDay: TimeOfDay =
    typeof rec.timeOfDay === 'string' && VALID_TIMES.has(rec.timeOfDay as TimeOfDay)
      ? (rec.timeOfDay as TimeOfDay)
      : base.timeOfDay;

  const weather: WeatherType =
    typeof rec.weather === 'string' && VALID_WEATHERS.has(rec.weather as WeatherType)
      ? (rec.weather as WeatherType)
      : base.weather;

  // Null-prototype maps prevent __proto__ / constructor pollution
  const speciesStats: Record<string, SpeciesCatchStats> = Object.create(null);
  if (rec.speciesStats && typeof rec.speciesStats === 'object' && !Array.isArray(rec.speciesStats)) {
    const statsRaw = rec.speciesStats as Record<string, unknown>;
    for (const key of Object.keys(statsRaw)) {
      if (!VALID_SPECIES_IDS.has(key)) continue;
      const entry = statsRaw[key];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const e = entry as Record<string, unknown>;
      const count = clampFiniteInt(e.count, 0, 0, 999999);
      if (count <= 0) continue;
      speciesStats[key] = {
        count,
        bestWeight: clampFiniteFloat(e.bestWeight, 0.5, 0.05, 500),
        bestLength: clampFiniteFloat(e.bestLength, 20, 5, 1000),
        firstCaughtAt: clampFiniteInt(e.firstCaughtAt, Date.now(), 0, 9999999999999),
      };
    }
  }

  const questProgress: Record<string, number> = Object.create(null);
  if (
    rec.questProgress &&
    typeof rec.questProgress === 'object' &&
    !Array.isArray(rec.questProgress)
  ) {
    const qpRaw = rec.questProgress as Record<string, unknown>;
    for (const key of Object.keys(qpRaw)) {
      if (!VALID_QUEST_IDS.has(key)) continue;
      const qDef = QUESTS.find((q) => q.id === key);
      const maxReq = qDef ? qDef.requirement.count : 999;
      questProgress[key] = clampFiniteInt(qpRaw[key], 0, 0, maxReq);
    }
  }

  let bestCatch: SaveSlotData['bestCatch'] = null;
  if (rec.bestCatch && typeof rec.bestCatch === 'object' && !Array.isArray(rec.bestCatch)) {
    const bc = rec.bestCatch as Record<string, unknown>;
    if (typeof bc.speciesId === 'string' && VALID_SPECIES_IDS.has(bc.speciesId)) {
      const sp = FISH_SPECIES.find((f) => f.id === bc.speciesId);
      if (sp) {
        bestCatch = {
          speciesId: sp.id,
          name: sp.name,
          weight: clampFiniteFloat(bc.weight, sp.minWeight, 0.05, 500),
          length: clampFiniteFloat(bc.length, sp.minLength, 5, 1000),
        };
      }
    }
  }

  const sanitized: SaveSlotData = {
    slotId: validSlot,
    updatedAt: clampFiniteInt(rec.updatedAt, Date.now(), 0, 9999999999999),
    playerTitle: base.playerTitle,
    gold: clampFiniteInt(rec.gold, base.gold, 0, 99999999),
    pearls: clampFiniteInt(rec.pearls, base.pearls, 0, 9999999),
    affinity: clampFiniteInt(rec.affinity, 0, 0, 999999),
    totalCount: clampFiniteInt(rec.totalCount, 0, 0, 9999999),
    totalWeight: clampFiniteFloat(rec.totalWeight, 0, 0, 99999999),
    releasedCount: clampFiniteInt(rec.releasedCount, 0, 0, 9999999),
    bestCatch,
    currentZoneId,
    timeOfDay,
    weather,
    unlockedZones,
    ownedRods,
    ownedReels,
    ownedLines,
    ownedLures,
    equippedRodId,
    equippedReelId,
    equippedLineId,
    equippedLureId,
    guardianScales: sanitizeIdList<string>(rec.guardianScales, VALID_GUARDIAN_IDS),
    speciesStats: { ...speciesStats },
    questProgress: { ...questProgress },
    completedQuests: sanitizeIdList<string>(rec.completedQuests, VALID_QUEST_IDS),
    storyChapter: clampFiniteInt(rec.storyChapter, 1, 1, 6),
    seenIntro: Boolean(rec.seenIntro),
  };

  sanitized.playerTitle = computePlayerTitle(sanitized);
  return sanitized;
}

export function getActiveSlotId(): number {
  try {
    const raw = localStorage.getItem(ACTIVE_SLOT_KEY);
    const parsed = raw ? parseInt(raw, 10) : 1;
    return [1, 2, 3].includes(parsed) ? parsed : 1;
  } catch {
    return 1;
  }
}

export function setActiveSlotId(slotId: number): void {
  const validSlot = [1, 2, 3].includes(slotId) ? slotId : 1;
  try {
    localStorage.setItem(ACTIVE_SLOT_KEY, String(validSlot));
  } catch {
    // ignore storage quota errors
  }
}

export function loadSlotData(slotId: number): SaveSlotData {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${slotId}`);
    if (!raw || raw.length > MAX_IMPORT_LENGTH * 2) return createInitialSaveData(slotId);
    const parsed: unknown = JSON.parse(raw);
    return sanitizeSaveData(parsed, slotId);
  } catch {
    return createInitialSaveData(slotId);
  }
}

export function saveSlotData(data: SaveSlotData): void {
  try {
    const updated = sanitizeSaveData(
      {
        ...data,
        updatedAt: Date.now(),
      },
      data.slotId,
    );
    localStorage.setItem(`${STORAGE_PREFIX}${updated.slotId}`, JSON.stringify(updated));
  } catch {
    // ignore storage quota errors
  }
}

export function resetSlotData(slotId: number): SaveSlotData {
  const fresh = createInitialSaveData(slotId);
  saveSlotData(fresh);
  return fresh;
}

export function exportSaveString(data: SaveSlotData): string {
  const clean = sanitizeSaveData(data, data.slotId);
  return `${SAVE_VERSION_PREFIX}${btoa(encodeURIComponent(JSON.stringify(clean)))}`;
}

export function importSaveString(encoded: string, targetSlotId: number): SaveSlotData | null {
  try {
    const trimmed = encoded.trim();
    if (!trimmed || trimmed.length > MAX_IMPORT_LENGTH) {
      return null;
    }
    const payload = trimmed.startsWith(SAVE_VERSION_PREFIX)
      ? trimmed.slice(SAVE_VERSION_PREFIX.length)
      : trimmed;

    const json = decodeURIComponent(atob(payload));
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const rec = parsed as Record<string, unknown>;
    if (
      typeof rec.gold !== 'number' ||
      !Number.isFinite(rec.gold) ||
      !Array.isArray(rec.ownedRods)
    ) {
      return null;
    }

    const sanitized = sanitizeSaveData(
      {
        ...rec,
        updatedAt: Date.now(),
      },
      targetSlotId,
    );
    saveSlotData(sanitized);
    return sanitized;
  } catch {
    return null;
  }
}

const RARITY_ORDER: Record<RarityTier, number> = {
  N: 1,
  R: 2,
  SR: 3,
  SSR: 4,
  UR: 5,
};

export function isRarityAtLeast(actual: RarityTier, minimum: RarityTier): boolean {
  return RARITY_ORDER[actual] >= RARITY_ORDER[minimum];
}

export function rollFishEncounter(
  zoneId: WaterZoneId,
  timeOfDay: TimeOfDay,
  weather: WeatherType,
  lureId: string,
  castPowerRatio: number,
  save: SaveSlotData,
): FishSpecies {
  const candidates = FISH_SPECIES.filter((f) => f.zoneId === zoneId);
  const safeCandidates =
    candidates.length > 0 ? candidates : FISH_SPECIES.filter((f) => f.zoneId === 'alpine_lake');
  const lure = LURES.find((l) => l.id === lureId) ?? LURES[0];

  const baseRarityWeight: Record<RarityTier, number> = {
    N: 46,
    R: 30,
    SR: 16,
    SSR: 6.5,
    UR: 2.5,
  };

  const weights = safeCandidates.map((fish) => {
    let w = baseRarityWeight[fish.rarity];

    if (fish.rarity === 'SR' || fish.rarity === 'SSR' || fish.rarity === 'UR') {
      w *= lure.rareWeightBonus;
    }
    if (fish.isGuardian) {
      w *= lure.guardianBonus;
    }
    if (fish.preferredLureIds?.includes(lure.id)) {
      w *= 1.85;
    }
    if (fish.preferredTime) {
      w *= fish.preferredTime.includes(timeOfDay) ? 1.65 : 0.65;
    }
    if (fish.preferredWeather) {
      w *= fish.preferredWeather.includes(weather) ? 1.65 : 0.72;
    }
    if (castPowerRatio > 0.65 && RARITY_ORDER[fish.rarity] >= 3) {
      w *= 1.35;
    }
    if (save.affinity > 0 && fish.isGuardian) {
      w *= 1 + Math.min(save.affinity * 0.03, 0.45);
    }
    return Math.max(w, 0.5);
  });

  const totalW = weights.reduce((acc, v) => acc + v, 0);
  let roll = Math.random() * totalW;
  for (let i = 0; i < safeCandidates.length; i++) {
    roll -= weights[i];
    if (roll <= 0) {
      return safeCandidates[i];
    }
  }
  return safeCandidates[0];
}

export function createCaughtInstance(
  species: FishSpecies,
  save: SaveSlotData,
): CaughtFishInstance {
  const affinityBias = Math.max(0.76, 0.88 - Math.min(save.affinity, 40) * 0.0025);
  const u = Math.pow(Math.random(), affinityBias);
  const weight = Number(
    (species.minWeight + u * (species.maxWeight - species.minWeight)).toFixed(2),
  );
  const weightNorm =
    (weight - species.minWeight) / Math.max(0.01, species.maxWeight - species.minWeight);
  const length = Number(
    (
      species.minLength +
      weightNorm * (species.maxLength - species.minLength) * (0.95 + Math.random() * 0.08)
    ).toFixed(1),
  );

  const sizeMultiplier = 0.85 + weightNorm * 0.65;
  const goldValue = Math.round(species.baseValue * sizeMultiplier);
  const pearlValue = species.pearlReward;

  const prevStats = save.speciesStats[species.id];
  const isNewSpecies = !prevStats || prevStats.count === 0;
  const isNewRecord = !prevStats || weight > prevStats.bestWeight;

  return {
    species,
    weight,
    length,
    goldValue,
    pearlValue,
    isNewSpecies,
    isNewRecord,
  };
}

export function evaluateQuestProgressOnAction(
  save: SaveSlotData,
  caught: CaughtFishInstance,
  action: 'keep' | 'release',
): SaveSlotData {
  const nextProgress = { ...save.questProgress };

  for (const quest of QUESTS) {
    if (save.completedQuests.includes(quest.id)) continue;
    if (quest.chapter > save.storyChapter) continue;

    const currentVal = nextProgress[quest.id] ?? 0;
    const req = quest.requirement;
    let delta = 0;

    if (req.type === 'catch_any') {
      delta = 1;
    } else if (req.type === 'catch_species' && req.targetId === caught.species.id) {
      delta = 1;
    } else if (req.type === 'catch_zone_count' && req.zoneId === caught.species.zoneId) {
      delta = 1;
    } else if (
      req.type === 'catch_rarity' &&
      req.rarity &&
      isRarityAtLeast(caught.species.rarity, req.rarity)
    ) {
      delta = 1;
    } else if (req.type === 'release_count' && action === 'release') {
      delta = 1;
    }

    if (delta > 0) {
      nextProgress[quest.id] = Math.min(req.count, currentVal + delta);
    }
  }

  return {
    ...save,
    questProgress: nextProgress,
  };
}

export function computePlayerTitle(save: SaveSlotData): string {
  const caughtSpeciesCount = Object.keys(save.speciesStats).length;
  if (save.speciesStats['aurelia_leviathan']?.count > 0) {
    return '永恆水鏡的傳奇守望者';
  }
  if (save.guardianScales.length >= 3) {
    return '三聖鱗共鳴的大釣師';
  }
  if (caughtSpeciesCount >= 10 || save.totalCount >= 20) {
    return '縱橫群島的尋鱗職人';
  }
  if (caughtSpeciesCount >= 4 || save.totalCount >= 5) {
    return '聽風辨水的溪湖釣客';
  }
  return '初臨水鏡的旅人';
}
