/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import {
  CHAPTER_TITLES,
  LINES,
  LURES,
  QUESTS,
  REELS,
  RODS,
  WATER_ZONES,
} from './data/gameData';
import {
  CaughtFishInstance,
  FishingState,
  LiveFishingHudState,
  SaveSlotData,
  TimeOfDay,
  WaterZoneId,
  WeatherType,
} from './types/game';
import {
  computePlayerTitle,
  evaluateQuestProgressOnAction,
  getActiveSlotId,
  importSaveString,
  loadSlotData,
  resetSlotData,
  saveSlotData,
  setActiveSlotId,
} from './utils/storage';
import { FishingSceneController } from './three/FishingSceneController';
import { soundEngine } from './audio/soundEngine';
import { CatchModal } from './components/CatchModal';
import { ActiveDrawerTab, GameDrawers } from './components/GameDrawers';

const TIME_ORDER: TimeOfDay[] = ['dawn', 'dusk', 'night'];
const TIME_SHORT: Record<TimeOfDay, string> = {
  dawn: '晨曦',
  dusk: '黃昏',
  night: '星夜',
};

const WEATHER_ORDER: WeatherType[] = ['clear', 'rain', 'mist'];
const WEATHER_SHORT: Record<WeatherType, string> = {
  clear: '晴朗',
  rain: '微雨',
  mist: '靈霧',
};

export default function App() {
  const canvasMountRef = useRef<HTMLDivElement | null>(null);
  const sceneControllerRef = useRef<FishingSceneController | null>(null);

  const [save, setSave] = useState<SaveSlotData>(() => loadSlotData(getActiveSlotId()));
  const saveRef = useRef<SaveSlotData>(save);
  saveRef.current = save;

  const [activeDrawer, setActiveDrawer] = useState<ActiveDrawerTab>(null);
  const [caughtFish, setCaughtFish] = useState<CaughtFishInstance | null>(null);
  const [zenCollapsed, setZenCollapsed] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [notice, setNotice] = useState<{
    text: string;
    tone: 'info' | 'warning' | 'success';
  } | null>(null);
  const noticeTimerRef = useRef<number | null>(null);

  const [hud, setHud] = useState<LiveFishingHudState>({
    state: FishingState.IDLE,
    statusMessage: '滑鼠微調拋投方向 · 按住 [滑鼠左鍵] 或 [空白鍵] 蓄力拋竿',
    isBiteUrgent: false,
    castPower: 0,
    aimAngleDeg: 0,
    lineTension: 30,
    safeZoneMin: 24,
    safeZoneMax: 80,
    fishDistance: 20,
    maxCastDistance: 20,
    fishStamina: 100,
    isFishBursting: false,
  });

  const pushNotice = useCallback(
    (text: string, tone: 'info' | 'warning' | 'success' = 'info') => {
      setNotice({ text, tone });
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = window.setTimeout(() => {
        setNotice(null);
      }, 3800);
    },
    [],
  );

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    };
  }, []);

  const commitSave = useCallback((updater: (prev: SaveSlotData) => SaveSlotData) => {
    setSave((prev) => {
      const next = updater(prev);
      const withTitle: SaveSlotData = {
        ...next,
        playerTitle: computePlayerTitle(next),
      };
      saveSlotData(withTitle);
      sceneControllerRef.current?.applyEnvironmentAndGear(withTitle, false);
      return withTitle;
    });
  }, []);

  // Mount isolated Three.js WebGL scene once
  useEffect(() => {
    const container = canvasMountRef.current;
    if (!container) return;

    const controller = new FishingSceneController(container, saveRef.current, {
      onHudUpdate: (nextHud) => setHud(nextHud),
      onFishCaught: (caught) => setCaughtFish(caught),
      onNotice: (msg, tone) => pushNotice(msg, tone),
    });
    sceneControllerRef.current = controller;

    return () => {
      controller.dispose();
      sceneControllerRef.current = null;
      soundEngine.dispose();
    };
  }, [pushNotice]);

  // Block canvas pointer/space input when drawers or catch modal are open
  useEffect(() => {
    const blocked = Boolean(activeDrawer || caughtFish);
    sceneControllerRef.current?.setUiBlocked(blocked);
  }, [activeDrawer, caughtFish]);

  // Keyboard shortcut [H] for Zen HUD collapse (guarded against text input focus)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.code === 'KeyH' && !activeDrawer && !caughtFish) {
        setZenCollapsed((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeDrawer, caughtFish]);

  const handleResolveCatch = useCallback(
    (action: 'keep' | 'release') => {
      if (!caughtFish) return;
      soundEngine.playUiChime();

      const { species, weight, length, goldValue, pearlValue } = caughtFish;
      const earnedGold =
        action === 'keep' ? goldValue : Math.max(10, Math.round(goldValue * 0.45));
      const earnedPearls = action === 'keep' ? pearlValue : pearlValue * 2 + 1;

      commitSave((prev) => {
        const prevSp = prev.speciesStats[species.id];
        const nextSpeciesStats = {
          ...prev.speciesStats,
          [species.id]: {
            count: (prevSp?.count ?? 0) + 1,
            bestWeight: Math.max(prevSp?.bestWeight ?? 0, weight),
            bestLength: Math.max(prevSp?.bestLength ?? 0, length),
            firstCaughtAt: prevSp?.firstCaughtAt ?? Date.now(),
          },
        };

        const nextBestCatch =
          !prev.bestCatch || weight > prev.bestCatch.weight
            ? { speciesId: species.id, name: species.name, weight, length }
            : prev.bestCatch;

        const nextScales =
          species.isGuardian && !prev.guardianScales.includes(species.id)
            ? [...prev.guardianScales, species.id]
            : prev.guardianScales;

        const updatedBase: SaveSlotData = {
          ...prev,
          gold: prev.gold + earnedGold,
          pearls: prev.pearls + earnedPearls,
          affinity: prev.affinity + (action === 'release' ? 2 : 0),
          totalCount: prev.totalCount + 1,
          totalWeight: Number((prev.totalWeight + weight).toFixed(2)),
          releasedCount: prev.releasedCount + (action === 'release' ? 1 : 0),
          bestCatch: nextBestCatch,
          guardianScales: nextScales,
          speciesStats: nextSpeciesStats,
        };

        return evaluateQuestProgressOnAction(updatedBase, caughtFish, action);
      });

      setCaughtFish(null);
      sceneControllerRef.current?.dismissCaughtShowcase();

      pushNotice(
        action === 'release'
          ? `已將【${species.name}】放流回歸水脈，獲得 +${earnedGold} 金幣 · +${earnedPearls} 水靈珠`
          : `已將【${species.name}】收入魚護，獲得 +${earnedGold} 金幣 · +${earnedPearls} 水靈珠`,
        'success',
      );
    },
    [caughtFish, commitSave, pushNotice],
  );

  const handleClaimQuest = useCallback(
    (questId: string) => {
      const quest = QUESTS.find((q) => q.id === questId);
      if (!quest) return;
      soundEngine.playCatchFanfare('SR');

      commitSave((prev) => {
        if (prev.completedQuests.includes(questId)) return prev;
        const nextCompleted = [...prev.completedQuests, questId];
        const nextUnlockedZones =
          quest.unlockZoneId && !prev.unlockedZones.includes(quest.unlockZoneId)
            ? [...prev.unlockedZones, quest.unlockZoneId]
            : prev.unlockedZones;

        // Advance story chapter when all quests of the current chapter are completed
        let nextChapter = prev.storyChapter;
        while (nextChapter < 6) {
          const chapterQuests = QUESTS.filter((q) => q.chapter === nextChapter);
          const allDone =
            chapterQuests.length > 0 &&
            chapterQuests.every((q) => nextCompleted.includes(q.id));
          if (allDone) {
            nextChapter += 1;
          } else {
            break;
          }
        }

        return {
          ...prev,
          gold: prev.gold + quest.rewardGold,
          pearls: prev.pearls + quest.rewardPearls,
          affinity: prev.affinity + 3,
          unlockedZones: nextUnlockedZones,
          completedQuests: nextCompleted,
          storyChapter: nextChapter,
        };
      });

      pushNotice(`完成委託「${quest.title}」！`, 'success');
    },
    [commitSave, pushNotice],
  );

  const handleBuyOrEquipRod = useCallback(
    (rodId: string) => {
      const item = RODS.find((r) => r.id === rodId);
      if (!item) return;
      soundEngine.playUiChime();
      commitSave((prev) => {
        if (prev.ownedRods.includes(rodId)) {
          return { ...prev, equippedRodId: rodId };
        }
        if (prev.gold < item.costGold || prev.pearls < item.costPearls) return prev;
        return {
          ...prev,
          gold: prev.gold - item.costGold,
          pearls: prev.pearls - item.costPearls,
          ownedRods: [...prev.ownedRods, rodId],
          equippedRodId: rodId,
        };
      });
    },
    [commitSave],
  );

  const handleBuyOrEquipReel = useCallback(
    (reelId: string) => {
      const item = REELS.find((r) => r.id === reelId);
      if (!item) return;
      soundEngine.playUiChime();
      commitSave((prev) => {
        if (prev.ownedReels.includes(reelId)) {
          return { ...prev, equippedReelId: reelId };
        }
        if (prev.gold < item.costGold || prev.pearls < item.costPearls) return prev;
        return {
          ...prev,
          gold: prev.gold - item.costGold,
          pearls: prev.pearls - item.costPearls,
          ownedReels: [...prev.ownedReels, reelId],
          equippedReelId: reelId,
        };
      });
    },
    [commitSave],
  );

  const handleBuyOrEquipLine = useCallback(
    (lineId: string) => {
      const item = LINES.find((l) => l.id === lineId);
      if (!item) return;
      soundEngine.playUiChime();
      commitSave((prev) => {
        if (prev.ownedLines.includes(lineId)) {
          return { ...prev, equippedLineId: lineId };
        }
        if (prev.gold < item.costGold || prev.pearls < item.costPearls) return prev;
        return {
          ...prev,
          gold: prev.gold - item.costGold,
          pearls: prev.pearls - item.costPearls,
          ownedLines: [...prev.ownedLines, lineId],
          equippedLineId: lineId,
        };
      });
    },
    [commitSave],
  );

  const handleBuyOrEquipLure = useCallback(
    (lureId: string) => {
      const item = LURES.find((l) => l.id === lureId);
      if (!item) return;
      soundEngine.playUiChime();
      commitSave((prev) => {
        if (prev.ownedLures.includes(lureId)) {
          return { ...prev, equippedLureId: lureId };
        }
        if (prev.gold < item.costGold || prev.pearls < item.costPearls) return prev;
        return {
          ...prev,
          gold: prev.gold - item.costGold,
          pearls: prev.pearls - item.costPearls,
          ownedLures: [...prev.ownedLures, lureId],
          equippedLureId: lureId,
        };
      });
    },
    [commitSave],
  );

  const handleUnlockOrTravelZone = useCallback(
    (zoneId: WaterZoneId) => {
      const zone = WATER_ZONES.find((z) => z.id === zoneId);
      if (!zone) return;
      soundEngine.playUiChime();
      let traveled = false;
      commitSave((prev) => {
        if (prev.unlockedZones.includes(zoneId)) {
          traveled = true;
          return { ...prev, currentZoneId: zoneId };
        }
        if (
          prev.gold < zone.unlockGold ||
          prev.guardianScales.length < zone.unlockScaleCount
        ) {
          return prev;
        }
        traveled = true;
        return {
          ...prev,
          gold: prev.gold - zone.unlockGold,
          unlockedZones: [...prev.unlockedZones, zoneId],
          currentZoneId: zoneId,
        };
      });
      if (traveled) {
        pushNotice(`已抵達秘境水域：${zone.name}`, 'info');
      }
    },
    [commitSave, pushNotice],
  );

  const handleChangeTimeOfDay = useCallback(
    (timeOfDay: TimeOfDay) => {
      soundEngine.playUiChime();
      commitSave((prev) => ({ ...prev, timeOfDay }));
    },
    [commitSave],
  );

  const handleChangeWeather = useCallback(
    (weather: WeatherType) => {
      soundEngine.playUiChime();
      commitSave((prev) => ({ ...prev, weather }));
    },
    [commitSave],
  );

  const handleCycleOwnedLure = useCallback(() => {
    soundEngine.playUiChime();
    commitSave((prev) => {
      const list = prev.ownedLures;
      if (list.length <= 1) return prev;
      const idx = list.indexOf(prev.equippedLureId);
      const nextId = list[(idx + 1) % list.length];
      return { ...prev, equippedLureId: nextId };
    });
  }, [commitSave]);

  const handleToggleMute = useCallback(() => {
    soundEngine.init();
    const next = !soundEngine.getMuted();
    soundEngine.setMuted(next);
    setIsMuted(next);
  }, []);

  const handleSwitchSlot = useCallback(
    (slotId: number) => {
      soundEngine.playUiChime();
      setActiveSlotId(slotId);
      const loaded = loadSlotData(slotId);
      setSave(loaded);
      sceneControllerRef.current?.applyEnvironmentAndGear(loaded, true);
      pushNotice(`已切換至本機存檔槽位 ${slotId}`, 'info');
    },
    [pushNotice],
  );

  const handleResetSlot = useCallback(
    (slotId: number) => {
      soundEngine.playUiChime();
      const fresh = resetSlotData(slotId);
      if (slotId === saveRef.current.slotId) {
        setSave(fresh);
        sceneControllerRef.current?.applyEnvironmentAndGear(fresh, true);
      }
      pushNotice(`已重置存檔槽位 ${slotId}`, 'warning');
    },
    [pushNotice],
  );

  const handleImportSave = useCallback(
    (encoded: string): boolean => {
      const imported = importSaveString(encoded, saveRef.current.slotId);
      if (!imported) return false;
      soundEngine.playUiChime();
      setSave(imported);
      sceneControllerRef.current?.applyEnvironmentAndGear(imported, true);
      pushNotice('成功匯入並還原存檔紀錄！', 'success');
      return true;
    },
    [pushNotice],
  );

  const currentZone = useMemo(
    () => WATER_ZONES.find((z) => z.id === save.currentZoneId) ?? WATER_ZONES[0],
    [save.currentZoneId],
  );

  const currentLure = useMemo(
    () => LURES.find((l) => l.id === save.equippedLureId) ?? LURES[0],
    [save.equippedLureId],
  );

  const claimableQuestCount = useMemo(
    () =>
      QUESTS.filter(
        (q) =>
          q.chapter <= save.storyChapter &&
          !save.completedQuests.includes(q.id) &&
          (save.questProgress[q.id] ?? 0) >= q.requirement.count,
      ).length,
    [save.storyChapter, save.completedQuests, save.questProgress],
  );

  const inSafeZone =
    hud.lineTension >= hud.safeZoneMin && hud.lineTension <= hud.safeZoneMax;

  return (
    <div className="relative w-screen h-screen overflow-hidden select-none bg-[#080e18] text-slate-100">
      {/* Isolated Full-Viewport Three.js WebGL Canvas Container */}
      <div ref={canvasMountRef} className="absolute inset-0 w-full h-full" />

      {/* ==================== STRICT 3-ZONE TOP BAR CONTRACT ==================== */}
      <header className="fixed top-0 inset-x-0 z-20 flex items-center justify-between gap-8 px-6 py-3.5 bg-[#080e18]/82 border-b border-white/10">
        {/* Zone 1: Single-element brand wordmark */}
        <a
          href="#sanctuary"
          onClick={(e) => {
            e.preventDefault();
            setActiveDrawer(null);
          }}
          className="font-display text-lg font-bold tracking-tight text-slate-50 whitespace-nowrap shrink-0"
        >
          蒼翠水鏡：遠古魚王傳說
        </a>

        {/* Zone 2: Concise single-line text navigation links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-300">
          <button
            type="button"
            onClick={() => {
              soundEngine.playUiChime();
              setActiveDrawer('mentor');
            }}
            className="hover:text-white underline-offset-4 hover:underline transition-colors whitespace-nowrap shrink-0 cursor-pointer text-teal-300 font-semibold"
          >
            水域智者 [AI]
          </button>
          <button
            type="button"
            onClick={() => {
              soundEngine.playUiChime();
              setActiveDrawer('quests');
            }}
            className="hover:text-white underline-offset-4 hover:underline transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            委託傳說
          </button>
          <button
            type="button"
            onClick={() => {
              soundEngine.playUiChime();
              setActiveDrawer('workshop');
            }}
            className="hover:text-white underline-offset-4 hover:underline transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            釣具工坊
          </button>
          <button
            type="button"
            onClick={() => {
              soundEngine.playUiChime();
              setActiveDrawer('encyclopedia');
            }}
            className="hover:text-white underline-offset-4 hover:underline transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            生態圖鑑
          </button>
          <button
            type="button"
            onClick={() => {
              soundEngine.playUiChime();
              setActiveDrawer('world');
            }}
            className="hover:text-white underline-offset-4 hover:underline transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            秘境天象
          </button>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => {
              soundEngine.playUiChime();
              setActiveDrawer('saves');
            }}
            className="px-4 py-2 text-xs font-semibold text-slate-950 bg-teal-400 hover:bg-teal-300 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            存檔與設定
          </button>
        </div>
      </header>

      {/* ==================== NON-OCCLUDING STATUS & ACTION CUES ==================== */}
      <div className="fixed top-16 left-1/2 -translate-x-1/2 z-10 pointer-events-none flex flex-col items-center gap-2.5 w-[min(620px,92vw)]">
        {/* Live Fishing Prompt Banner */}
        <div
          className={`px-4 py-2 rounded-xl border text-xs sm:text-sm font-medium text-center transition-colors ${
            hud.isBiteUrgent
              ? 'bg-amber-950/92 border-amber-400/70 text-amber-200 shadow-lg'
              : 'bg-[#0b1320]/84 border-white/10 text-slate-200'
          }`}
        >
          {hud.statusMessage}
        </div>

        {/* Transient Event Notice Toast */}
        {notice && (
          <div
            className={`px-4 py-2 rounded-xl border text-xs font-medium text-center ${
              notice.tone === 'warning'
                ? 'bg-rose-950/92 border-rose-400/50 text-rose-200'
                : notice.tone === 'success'
                  ? 'bg-teal-950/92 border-teal-400/50 text-teal-200'
                  : 'bg-[#0b1320]/92 border-sky-400/40 text-sky-200'
            }`}
          >
            {notice.text}
          </div>
        )}

        {/* Cast Power Meter (Visible during CHARGING) */}
        {hud.state === FishingState.CHARGING && (
          <div className="w-full max-w-sm rounded-xl bg-[#0b1320]/92 border border-white/14 px-4 py-3 space-y-1.5">
            <div className="flex items-center justify-between text-xs font-mono tabular-nums">
              <span className="font-sans text-slate-300">拋竿蓄力強度</span>
              <span className="text-teal-300 font-semibold">
                {hud.castPower}% · 偏角 {hud.aimAngleDeg}°
              </span>
            </div>
            <div className="w-full h-2.5 rounded-full bg-slate-800 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-teal-400 via-sky-400 to-amber-300 transition-transform duration-75 origin-left"
                style={{ transform: `scaleX(${hud.castPower / 100})` }}
              />
            </div>
          </div>
        )}

        {/* Active Reeling Tension & Stamina Combat Instrument (Visible during REELING) */}
        {hud.state === FishingState.REELING && (
          <div className="w-full max-w-md rounded-xl bg-[#0b1320]/94 border border-white/15 px-5 py-3.5 space-y-2.5 shadow-2xl">
            <div className="flex items-center justify-between text-xs font-mono tabular-nums">
              <span
                className={`font-sans font-semibold ${
                  hud.lineTension >= 82
                    ? 'text-rose-300'
                    : inSafeZone
                      ? 'text-teal-300'
                      : 'text-amber-300'
                }`}
              >
                {hud.lineTension >= 82
                  ? '高張力危險 · 放開卸力'
                  : hud.lineTension <= 14
                    ? '張力過低 · 小心脫鉤'
                    : hud.isFishBursting
                      ? '大魚暴衝抗衡中'
                      : '翠綠安全控線區間'}
              </span>
              <span className="text-slate-200">
                張力 {hud.lineTension}% · 距離 {hud.fishDistance.toFixed(1)}m
              </span>
            </div>

            {/* Tension Track with Highlighted Safe Zone Band */}
            <div className="relative w-full h-3 rounded-full bg-slate-800 overflow-hidden border border-white/10">
              <div
                className="absolute top-0 bottom-0 bg-teal-400/22 border-x border-teal-300/60"
                style={{
                  left: `${hud.safeZoneMin}%`,
                  width: `${Math.max(10, hud.safeZoneMax - hud.safeZoneMin)}%`,
                }}
              />
              <div
                className={`h-full transition-transform duration-75 origin-left ${
                  hud.lineTension >= 82
                    ? 'bg-rose-500'
                    : inSafeZone
                      ? 'bg-teal-400'
                      : 'bg-amber-400'
                }`}
                style={{ transform: `scaleX(${hud.lineTension / 100})` }}
              />
            </div>

            {/* Fish Stamina Bar */}
            <div className="flex items-center justify-between gap-3 text-xs font-mono tabular-nums text-slate-400">
              <span className="font-sans shrink-0">大魚剩餘體力</span>
              <div className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-sky-400 transition-transform duration-100 origin-left"
                  style={{ transform: `scaleX(${hud.fishStamina / 100})` }}
                />
              </div>
              <span className="w-9 text-right text-sky-300">{hud.fishStamina}%</span>
            </div>
          </div>
        )}
      </div>

      {/* ==================== COLLAPSIBLE BOTTOM CONTROL DOCK ==================== */}
      <div
        className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-20 w-[min(940px,94vw)] transition-transform duration-200 ${
          zenCollapsed ? 'translate-y-[calc(100%-28px)]' : 'translate-y-0'
        }`}
      >
        {/* Collapse / Zen Mode Tab Handle */}
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => setZenCollapsed((prev) => !prev)}
            className="flex items-center gap-1.5 px-4 py-1 rounded-t-xl bg-[#0b1320]/94 border-t border-x border-white/14 text-xs font-medium text-slate-300 hover:text-white transition-colors whitespace-nowrap cursor-pointer"
          >
            {zenCollapsed ? (
              <>
                <ChevronUp className="w-3.5 h-3.5" />
                <span>展開控制塢 [H]</span>
              </>
            ) : (
              <>
                <ChevronDown className="w-3.5 h-3.5" />
                <span>收合沉浸賞景 [H]</span>
              </>
            )}
          </button>
        </div>

        {/* Main Horizontal Dock */}
        <div className="rounded-2xl bg-[#0b1320]/94 border border-white/14 px-5 py-3.5 shadow-2xl space-y-2.5">
          {/* Row 1: Clean Unboxed Metadata Bar with Typographic Separators */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300 border-b border-white/8 pb-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-teal-300">
                {CHAPTER_TITLES[save.storyChapter] ?? CHAPTER_TITLES[6]}
              </span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span className="text-slate-100 font-medium">{currentZone.name}</span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span>水深 {currentZone.depthText}</span>
            </div>

            <div className="flex flex-wrap items-center gap-2 font-mono tabular-nums">
              <span>
                漁獲 {save.totalCount} 尾 ({save.totalWeight.toFixed(2)} kg)
              </span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span className="text-amber-300">{save.gold} 金幣</span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span className="text-teal-300">{save.pearls} 水靈珠</span>
              {save.bestCatch && (
                <>
                  <span aria-hidden="true" className="text-slate-600">·</span>
                  <span className="text-sky-300 font-sans">
                    最大：{save.bestCatch.name} {save.bestCatch.weight.toFixed(2)}kg
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Row 2: Quick Interactive Controls & Mobile Drawer Triggers */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (save.ownedLures.length > 1) {
                    handleCycleOwnedLure();
                  } else {
                    setActiveDrawer('workshop');
                  }
                }}
                className="px-3 py-1.5 rounded-lg bg-slate-800/90 hover:bg-slate-700 border border-white/10 text-xs text-slate-100 whitespace-nowrap shrink-0 transition-colors cursor-pointer"
              >
                擬餌：{currentLure.name}
              </button>

              <button
                type="button"
                onClick={() => {
                  const nextTime =
                    TIME_ORDER[(TIME_ORDER.indexOf(save.timeOfDay) + 1) % TIME_ORDER.length];
                  handleChangeTimeOfDay(nextTime);
                }}
                className="px-3 py-1.5 rounded-lg bg-slate-800/90 hover:bg-slate-700 border border-white/10 text-xs text-slate-200 whitespace-nowrap shrink-0 transition-colors cursor-pointer"
              >
                時段：{TIME_SHORT[save.timeOfDay]}
              </button>

              <button
                type="button"
                onClick={() => {
                  const nextW =
                    WEATHER_ORDER[(WEATHER_ORDER.indexOf(save.weather) + 1) % WEATHER_ORDER.length];
                  handleChangeWeather(nextW);
                }}
                className="px-3 py-1.5 rounded-lg bg-slate-800/90 hover:bg-slate-700 border border-white/10 text-xs text-slate-200 whitespace-nowrap shrink-0 transition-colors cursor-pointer"
              >
                天候：{WEATHER_SHORT[save.weather]}
              </button>

              <button
                type="button"
                onClick={handleToggleMute}
                className="px-3 py-1.5 rounded-lg bg-slate-800/90 hover:bg-slate-700 border border-white/10 text-xs text-slate-200 whitespace-nowrap shrink-0 transition-colors cursor-pointer"
              >
                {isMuted ? '音訊：靜音' : '音訊：開啟'}
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  soundEngine.playUiChime();
                  setActiveDrawer('quests');
                }}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                  claimableQuestCount > 0
                    ? 'bg-amber-400 hover:bg-amber-300 text-slate-950'
                    : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-white/10'
                }`}
              >
                {claimableQuestCount > 0
                  ? `領取委託回報 (${claimableQuestCount})`
                  : '委託與傳說'}
              </button>

              <button
                type="button"
                onClick={() => {
                  soundEngine.playUiChime();
                  setActiveDrawer('workshop');
                }}
                className="px-3.5 py-1.5 rounded-lg bg-teal-400 hover:bg-teal-300 text-slate-950 text-xs font-semibold whitespace-nowrap shrink-0 transition-colors cursor-pointer"
              >
                釣具工坊
              </button>

              <button
                type="button"
                onClick={() => {
                  soundEngine.playUiChime();
                  setActiveDrawer('encyclopedia');
                }}
                className="md:hidden px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer"
              >
                圖鑑
              </button>

              <button
                type="button"
                onClick={() => {
                  soundEngine.playUiChime();
                  setActiveDrawer('world');
                }}
                className="px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-white/10 text-xs font-medium text-slate-200 whitespace-nowrap shrink-0 cursor-pointer"
              >
                切換水域
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ==================== CATCH SETTLEMENT MODAL ==================== */}
      <CatchModal
        caught={caughtFish}
        alreadyHasScale={
          caughtFish ? save.guardianScales.includes(caughtFish.species.id) : false
        }
        onResolve={handleResolveCatch}
      />

      {/* ==================== UNIFIED SANCTUARY DRAWERS ==================== */}
      <GameDrawers
        activeTab={activeDrawer}
        onClose={() => setActiveDrawer(null)}
        onSwitchTab={(tab) => {
          soundEngine.playUiChime();
          setActiveDrawer(tab);
        }}
        save={save}
        isMuted={isMuted}
        onToggleMute={handleToggleMute}
        onClaimQuest={handleClaimQuest}
        onBuyOrEquipRod={handleBuyOrEquipRod}
        onBuyOrEquipReel={handleBuyOrEquipReel}
        onBuyOrEquipLine={handleBuyOrEquipLine}
        onBuyOrEquipLure={handleBuyOrEquipLure}
        onUnlockOrTravelZone={handleUnlockOrTravelZone}
        onChangeTimeOfDay={handleChangeTimeOfDay}
        onChangeWeather={handleChangeWeather}
        onSwitchSlot={handleSwitchSlot}
        onResetSlot={handleResetSlot}
        onImportSave={handleImportSave}
      />
    </div>
  );
}
