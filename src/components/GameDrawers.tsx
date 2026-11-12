import { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Check,
  Compass,
  Copy,
  Hammer,
  Lock,
  MessageSquare,
  RotateCcw,
  ScrollText,
  Sparkles,
  Upload,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  CHAPTER_TITLES,
  FISH_SPECIES,
  LINES,
  LURES,
  NPCS,
  QUESTS,
  REELS,
  RODS,
  WATER_ZONES,
} from '../data/gameData';
import {
  NpcId,
  SaveSlotData,
  TimeOfDay,
  WaterZoneId,
  WeatherType,
} from '../types/game';
import { exportSaveString, loadSlotData } from '../utils/storage';
import { FishPreview3D } from './FishPreview3D';
import { ResilientArtwork } from './ResilientArtwork';

export type ActiveDrawerTab =
  | null
  | 'mentor'
  | 'quests'
  | 'workshop'
  | 'encyclopedia'
  | 'world'
  | 'saves';

interface GameDrawersProps {
  activeTab: ActiveDrawerTab;
  onClose: () => void;
  onSwitchTab: (tab: ActiveDrawerTab) => void;
  save: SaveSlotData;
  isMuted: boolean;
  onToggleMute: () => void;
  onClaimQuest: (questId: string) => void;
  onBuyOrEquipRod: (rodId: string) => void;
  onBuyOrEquipReel: (reelId: string) => void;
  onBuyOrEquipLine: (lineId: string) => void;
  onBuyOrEquipLure: (lureId: string) => void;
  onUnlockOrTravelZone: (zoneId: WaterZoneId) => void;
  onChangeTimeOfDay: (time: TimeOfDay) => void;
  onChangeWeather: (weather: WeatherType) => void;
  onSwitchSlot: (slotId: number) => void;
  onResetSlot: (slotId: number) => void;
  onImportSave: (encoded: string) => boolean;
}

const TIME_LABELS: Record<TimeOfDay, string> = {
  dawn: '晨曦微光',
  dusk: '黃金黃昏',
  night: '靜謐星夜',
};

const WEATHER_LABELS: Record<WeatherType, string> = {
  clear: '晴朗無雲',
  rain: '煙雨微瀾',
  mist: '空谷靈霧',
};

function numHexToCss(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

export function GameDrawers({
  activeTab,
  onClose,
  onSwitchTab,
  save,
  isMuted,
  onToggleMute,
  onClaimQuest,
  onBuyOrEquipRod,
  onBuyOrEquipReel,
  onBuyOrEquipLine,
  onBuyOrEquipLure,
  onUnlockOrTravelZone,
  onChangeTimeOfDay,
  onChangeWeather,
  onSwitchSlot,
  onResetSlot,
  onImportSave,
}: GameDrawersProps) {
  const [selectedNpc, setSelectedNpc] = useState<NpcId>('xuan');
  const [workshopCategory, setWorkshopCategory] = useState<'rod' | 'reel' | 'line' | 'lure'>('rod');
  const [encZoneFilter, setEncZoneFilter] = useState<'all' | WaterZoneId>('all');
  const [selectedSpeciesId, setSelectedSpeciesId] = useState<string>(FISH_SPECIES[0].id);
  const [importText, setImportText] = useState('');
  const [copyStatus, setCopyStatus] = useState<{ text: string; ok: boolean } | null>(null);
  const [confirmResetSlot, setConfirmResetSlot] = useState<number | null>(null);
  const statusTimerRef = useRef<number | null>(null);

  // AI Mentor dialog state with cache hit telemetry
  const [mentorMessages, setMentorMessages] = useState<Array<{
    sender: 'user' | 'mentor';
    text: string;
    cacheStats?: { cachedTokens: number; totalTokens: number; isCacheHit: boolean; discountApplied: string };
  }>>([
    {
      sender: 'mentor',
      text: '小友，老朽感應到你漫步於水鏡之境。水流湍緩各有其道，魚性靈慧各有其喜。若對水域魚王、釣竿調校或水神傳說有所困惑，不妨與老朽相談。',
    },
  ]);
  const [mentorInput, setMentorInput] = useState('');
  const [isMentorLoading, setIsMentorLoading] = useState(false);
  const [mentorError, setMentorError] = useState<string | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [mentorMessages, isMentorLoading]);

  useEffect(() => {
    return () => {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!activeTab) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeTab, onClose]);

  if (!activeTab) return null;

  const setTransientStatus = (text: string, ok: boolean, ms = 3000) => {
    setCopyStatus({ text, ok });
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = window.setTimeout(() => {
      setCopyStatus(null);
    }, ms);
  };

  const filteredSpecies =
    encZoneFilter === 'all'
      ? FISH_SPECIES
      : FISH_SPECIES.filter((s) => s.zoneId === encZoneFilter);

  const inspectedSpecies =
    filteredSpecies.find((s) => s.id === selectedSpeciesId) ??
    FISH_SPECIES.find((s) => s.id === selectedSpeciesId) ??
    filteredSpecies[0] ??
    FISH_SPECIES[0];

  const inspectedStats = save.speciesStats[inspectedSpecies.id];
  const isInspectedUnlocked = Boolean(inspectedStats && inspectedStats.count > 0);
  const discoveredTotal = Object.values(save.speciesStats).filter((s) => s.count > 0).length;

  const activeNpc = NPCS[selectedNpc];
  const npcQuests = QUESTS.filter(
    (q) => q.npcId === selectedNpc && q.chapter <= save.storyChapter,
  );

  const handleCopyExport = () => {
    const code = exportSaveString(save);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).then(
        () => {
          setTransientStatus('安全存檔碼已複製至剪貼簿', true, 2600);
        },
        () => {
          setImportText(code);
          setTransientStatus('已產生存檔碼於下方輸入框，請手動全選複製', true, 4000);
        },
      );
    } else {
      setImportText(code);
      setTransientStatus('已產生存檔碼於下方輸入框，請手動全選複製', true, 4000);
    }
  };

  const handleRunImport = () => {
    if (!importText.trim()) return;
    const ok = onImportSave(importText);
    setTransientStatus(
      ok ? '存檔驗證通過並已成功還原！' : '存檔碼格式或校驗無效，已拒絕匯入以保護現有進度。',
      ok,
      3600,
    );
    if (ok) setImportText('');
  };

  const handleSendMentorMessage = async (queryText?: string) => {
    const textToSend = (queryText ?? mentorInput).trim();
    if (!textToSend || isMentorLoading) return;

    setMentorInput('');
    setMentorError(null);
    setMentorMessages((prev) => [...prev, { sender: 'user', text: textToSend }]);
    setIsMentorLoading(true);

    try {
      const currentZoneObj = WATER_ZONES.find((z) => z.id === save.currentZoneId);
      const rodObj = RODS.find((r) => r.id === save.equippedRodId);
      const reelObj = REELS.find((r) => r.id === save.equippedReelId);
      const lineObj = LINES.find((l) => l.id === save.equippedLineId);

      const resp = await fetch('/api/gemini/mentor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: textToSend,
          currentZone: currentZoneObj ? `${currentZoneObj.name} (${currentZoneObj.id})` : undefined,
          timeOfDay: save.timeOfDay,
          weather: save.weather,
          equippedRod: rodObj?.name,
          equippedReel: reelObj?.name,
          equippedLine: lineObj?.name,
        }),
      });

      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || '傳送失敗，請稍後重試。');
      }

      setMentorMessages((prev) => [
        ...prev,
        {
          sender: 'mentor',
          text: data.reply,
          cacheStats: data.cacheStats,
        },
      ]);
    } catch (err: any) {
      setMentorError(err?.message || '玄老暫未收到傳音，請稍後再試。');
    } finally {
      setIsMentorLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center p-4 md:p-8 bg-slate-950/70 pointer-events-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-5xl max-h-[88vh] flex flex-col rounded-2xl bg-[#0b1320]/98 border border-white/14 shadow-2xl text-slate-100 overflow-hidden">
        {/* Modal Header with Tab Switcher & Resource Summary */}
        <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-4 border-b border-white/10 bg-[#080e18]/80">
          <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-900/90 border border-white/8 overflow-x-auto">
            {[
              { id: 'mentor' as const, label: '水域智者 [AI]', icon: MessageSquare },
              { id: 'quests' as const, label: '委託傳說', icon: ScrollText },
              { id: 'workshop' as const, label: '釣具工坊', icon: Hammer },
              { id: 'encyclopedia' as const, label: '生態圖鑑', icon: BookOpen },
              { id: 'world' as const, label: '秘境天象', icon: Compass },
              { id: 'saves' as const, label: '存檔音訊', icon: RotateCcw },
            ].map((item) => {
              const Icon = item.icon;
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSwitchTab(item.id)}
                  className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                    active
                      ? 'bg-teal-400 text-slate-950 font-semibold'
                      : 'text-slate-300 hover:text-white hover:bg-white/5'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-5">
            <div className="flex items-center gap-2.5 text-xs sm:text-sm font-mono tabular-nums text-slate-200">
              <span className="text-amber-300">{save.gold} 金幣</span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span className="text-teal-300">{save.pearls} 水靈珠</span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span className="text-sky-300">{save.guardianScales.length}/4 聖鱗</span>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="關閉面板"
              className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Scrollable Content Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* ==================== 0. AI MENTOR DIALOG (玄老水域智者) ==================== */}
          {activeTab === 'mentor' && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start h-full">
              {/* Left Column: NPC Illustrated Portrait & Zone Context */}
              <div className="lg:col-span-4 space-y-4">
                <div className="rounded-xl bg-[#101b2d] border border-white/10 p-5 text-center">
                  <div className="relative w-28 h-28 mx-auto rounded-2xl overflow-hidden border-2 border-teal-400/40 shadow-lg mb-3.5">
                    <ResilientArtwork
                      src={NPCS.xuan.portraitUrl}
                      alt={NPCS.xuan.name}
                      fallbackLabel={NPCS.xuan.name}
                      fallbackGradient="from-teal-900 to-slate-900"
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <h3 className="font-display text-lg font-bold text-slate-100">
                    {NPCS.xuan.name}
                  </h3>
                  <div className="text-xs text-teal-300 font-medium mb-2.5">
                    {NPCS.xuan.title}
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed text-left">
                    {NPCS.xuan.greeting}
                  </p>
                </div>

                <div className="rounded-xl bg-[#101b2d] border border-white/10 p-4 space-y-2 text-xs">
                  <div className="font-semibold text-slate-200 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-teal-400" />
                    <span>Gemini 隱式前綴快取已啟動</span>
                  </div>
                  <p className="text-slate-400 leading-relaxed">
                    水域秘笈與生態資料已封裝為常駐系統前綴，能自動享受高達 90% 的 Token 折扣，確保流暢且低開銷的傳音諮詢。
                  </p>
                  <div className="pt-2 border-t border-white/8 text-slate-400 space-y-1 font-mono text-[11px]">
                    <div>目前水域：{WATER_ZONES.find((z) => z.id === save.currentZoneId)?.name}</div>
                    <div>當前天候：{TIME_LABELS[save.timeOfDay]} · {WEATHER_LABELS[save.weather]}</div>
                  </div>
                </div>
              </div>

              {/* Right Column: Chat History & Interactive Prompt Chips */}
              <div className="lg:col-span-8 flex flex-col h-[520px] rounded-xl bg-[#101b2d] border border-white/10 overflow-hidden">
                {/* Chat Messages Log */}
                <div ref={chatScrollRef} className="flex-1 overflow-y-auto p-5 space-y-4">
                  {mentorMessages.map((msg, idx) => (
                    <div
                      key={idx}
                      className={`flex flex-col ${
                        msg.sender === 'user' ? 'items-end' : 'items-start'
                      }`}
                    >
                      <div
                        className={`max-w-[85%] rounded-2xl px-4 py-3 text-xs sm:text-sm leading-relaxed whitespace-pre-wrap ${
                          msg.sender === 'user'
                            ? 'bg-teal-500 text-slate-950 font-medium rounded-br-none shadow-sm'
                            : 'bg-[#0b1320] text-slate-200 border border-white/10 rounded-bl-none'
                        }`}
                      >
                        {msg.text}
                      </div>

                      {/* Cache Hit Badge for Mentor Reply */}
                      {msg.cacheStats && (
                        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-teal-300 font-mono">
                          <Sparkles className="w-3 h-3" />
                          <span>
                            {msg.cacheStats.isCacheHit
                              ? `⚡ 快取命中：${msg.cacheStats.cachedTokens} Tokens (~90% 折扣)`
                              : `前綴建置完成 (${msg.cacheStats.totalTokens} Tokens)`}
                          </span>
                        </div>
                      )}
                    </div>
                  ))}

                  {isMentorLoading && (
                    <div className="flex items-center gap-2 text-xs text-teal-300/80 italic font-mono py-2">
                      <Sparkles className="w-4 h-4 animate-spin" />
                      <span>玄老凝神感應水流靈脈中...</span>
                    </div>
                  )}

                  {mentorError && (
                    <div className="p-3 rounded-lg bg-rose-950/80 border border-rose-400/40 text-xs text-rose-200">
                      {mentorError}
                    </div>
                  )}
                </div>

                {/* Quick Recommended Prompt Chips */}
                <div className="px-4 py-2.5 bg-[#0b1320]/60 border-t border-white/6 flex flex-wrap gap-1.5">
                  {[
                    '如何釣到黃金帝王鮭？',
                    '當前水域推薦什麼擬餌與釣具？',
                    '搏魚時常斷線該如何調控張力？',
                    '四大水域沉睡的水神龍有何傳說？',
                  ].map((chip) => (
                    <button
                      key={chip}
                      type="button"
                      disabled={isMentorLoading}
                      onClick={() => handleSendMentorMessage(chip)}
                      className="px-2.5 py-1 rounded-md bg-slate-800/80 hover:bg-slate-700 text-[11px] text-slate-300 hover:text-white border border-white/8 transition-colors disabled:opacity-50 cursor-pointer"
                    >
                      {chip}
                    </button>
                  ))}
                </div>

                {/* Input Bar */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleSendMentorMessage();
                  }}
                  className="flex items-center gap-2 p-3 bg-[#080e18] border-t border-white/10"
                >
                  <input
                    type="text"
                    value={mentorInput}
                    onChange={(e) => setMentorInput(e.target.value)}
                    placeholder="向玄老請教水域生態、釣王秘訣或釣竿調試..."
                    disabled={isMentorLoading}
                    className="flex-1 rounded-lg bg-[#101b2d] border border-white/12 px-3.5 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-teal-400 disabled:opacity-50"
                  />
                  <button
                    type="submit"
                    disabled={isMentorLoading || !mentorInput.trim()}
                    className="px-4 py-2 rounded-lg bg-teal-400 hover:bg-teal-300 text-slate-950 text-xs font-semibold whitespace-nowrap shrink-0 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  >
                    傳音請教
                  </button>
                </form>
              </div>
            </div>
          )}

          {/* ==================== 1. STORY & NPC QUESTS ==================== */}
          {activeTab === 'quests' && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* Left Column: Story Chapter & Illustrated NPC Selector */}
              <div className="lg:col-span-5 space-y-5">
                <div className="rounded-xl bg-[#101b2d] border border-white/10 p-5">
                  <div className="text-xs text-teal-300 font-medium mb-1">
                    {CHAPTER_TITLES[save.storyChapter] ?? CHAPTER_TITLES[6]}
                  </div>
                  <h3 className="font-display text-xl font-bold text-slate-50 mb-2">
                    {save.playerTitle}
                  </h3>
                  <p className="text-sm text-slate-300 leading-relaxed">
                    水鏡群島曾受遠古水神奧瑞莉亞庇佑。傾聽島民的委託、在四大水域收集守護聖鱗，沉睡的天際神殿終將再度開啟。
                  </p>
                  <div className="mt-4 pt-3 border-t border-white/8 flex flex-wrap items-center gap-2 text-xs text-slate-400 font-mono tabular-nums">
                    <span>已完成委託 {save.completedQuests.length}/{QUESTS.length}</span>
                    <span aria-hidden="true">·</span>
                    <span>水神親和度 {save.affinity}</span>
                    <span aria-hidden="true">·</span>
                    <span>放流祈福 {save.releasedCount} 次</span>
                  </div>
                </div>

                {/* Illustrated NPC Cards */}
                <div className="space-y-2.5">
                  {(['xuan', 'mio', 'bailu'] as NpcId[]).map((npcId) => {
                    const npc = NPCS[npcId];
                    const isSelected = selectedNpc === npcId;
                    const readyCount = QUESTS.filter(
                      (q) =>
                        q.npcId === npcId &&
                        q.chapter <= save.storyChapter &&
                        !save.completedQuests.includes(q.id) &&
                        (save.questProgress[q.id] ?? 0) >= q.requirement.count,
                    ).length;

                    return (
                      <button
                        key={npcId}
                        type="button"
                        onClick={() => setSelectedNpc(npcId)}
                        className={`w-full text-left rounded-xl p-3.5 border transition-colors flex items-center gap-4 cursor-pointer ${
                          isSelected
                            ? 'bg-[#14243b] border-teal-400/55'
                            : 'bg-[#0f1928] border-white/8 hover:border-white/20'
                        }`}
                      >
                        <ResilientArtwork
                          src={npc.portraitUrl}
                          alt={`${npc.name} — ${npc.title}`}
                          fallbackLabel={npc.name}
                          className="w-14 h-14 rounded-lg shrink-0 border border-white/15"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 truncate">
                              <span className="font-display text-base font-bold text-slate-50">
                                {npc.name}
                              </span>
                              <span aria-hidden="true" className="text-slate-600">·</span>
                              <span
                                className="text-xs font-medium truncate"
                                style={{ color: npc.accentColor }}
                              >
                                {npc.title}
                              </span>
                            </div>
                            {readyCount > 0 && (
                              <span className="text-xs font-semibold text-amber-300 whitespace-nowrap shrink-0">
                                可回報 ({readyCount})
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-slate-400 mt-1 line-clamp-1">
                            {npc.backstory}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Right Column: Active NPC Portrait Showcase + Quests */}
              <div className="lg:col-span-7 space-y-4">
                <div className="rounded-xl bg-[#101b2d] border border-white/10 p-5 flex flex-col sm:flex-row items-center sm:items-start gap-5">
                  <ResilientArtwork
                    src={activeNpc.portraitUrl}
                    alt={`${activeNpc.name} 角色立繪`}
                    fallbackLabel={activeNpc.name}
                    className="w-28 h-28 sm:w-32 sm:h-32 rounded-xl shrink-0 border border-white/15 shadow-lg"
                  />
                  <div className="space-y-2 text-center sm:text-left">
                    <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2 text-xs">
                      <span
                        className="font-semibold"
                        style={{ color: activeNpc.accentColor }}
                      >
                        {activeNpc.title}
                      </span>
                      <span aria-hidden="true" className="text-slate-600">·</span>
                      <span className="text-slate-400">水鏡群島守望者</span>
                    </div>
                    <h4 className="font-display text-2xl font-bold text-slate-50">
                      {activeNpc.name}
                    </h4>
                    <p className="text-sm text-teal-100/95 leading-relaxed italic">
                      {activeNpc.greeting}
                    </p>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      {activeNpc.backstory}
                    </p>
                  </div>
                </div>

                {/* Quest List for Selected NPC */}
                <div className="space-y-3.5">
                  {npcQuests.length === 0 ? (
                    <div className="rounded-xl bg-[#0f1928] border border-white/8 p-6 text-center text-sm text-slate-400">
                      推進當前章節委託後，{activeNpc.name}將會分享新的水鏡傳說。
                    </div>
                  ) : (
                    npcQuests.map((quest) => {
                      const isCompleted = save.completedQuests.includes(quest.id);
                      const progress = Math.min(
                        quest.requirement.count,
                        save.questProgress[quest.id] ?? 0,
                      );
                      const isReady = !isCompleted && progress >= quest.requirement.count;
                      const pct = Math.round((progress / quest.requirement.count) * 100);

                      return (
                        <div
                          key={quest.id}
                          className={`rounded-xl border p-5 transition-colors ${
                            isReady
                              ? 'bg-amber-950/20 border-amber-400/45'
                              : isCompleted
                                ? 'bg-[#0c1422] border-white/8 opacity-80'
                                : 'bg-[#101b2d] border-white/10'
                          }`}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                            <h5 className="font-display text-lg font-bold text-slate-50">
                              {quest.title}
                            </h5>
                            <div className="text-xs font-mono tabular-nums text-slate-400">
                              {isCompleted ? (
                                <span className="inline-flex items-center gap-1 text-teal-300">
                                  <Check className="w-3.5 h-3.5" />
                                  已完成
                                </span>
                              ) : (
                                <span>
                                  進度 {progress}/{quest.requirement.count}
                                </span>
                              )}
                            </div>
                          </div>

                          <p className="text-sm text-slate-300 leading-relaxed mb-3">
                            {isCompleted || isReady
                              ? quest.narrativeComplete
                              : quest.narrativeIntro}
                          </p>

                          <div className="text-xs text-sky-300 mb-2">
                            委託目標：{quest.objectiveText}
                          </div>

                          {!isCompleted && (
                            <div className="w-full h-1.5 rounded-full bg-slate-800 overflow-hidden mb-4">
                              <div
                                className="h-full bg-teal-400 transition-transform duration-200 origin-left"
                                style={{ transform: `scaleX(${pct / 100})` }}
                              />
                            </div>
                          )}

                          <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-white/8">
                            <div className="flex flex-wrap items-center gap-2 text-xs font-mono tabular-nums text-slate-300">
                              <span className="text-amber-300">+{quest.rewardGold} 金幣</span>
                              <span aria-hidden="true" className="text-slate-600">·</span>
                              <span className="text-teal-300">+{quest.rewardPearls} 水靈珠</span>
                              {quest.unlockZoneId && (
                                <>
                                  <span aria-hidden="true" className="text-slate-600">·</span>
                                  <span className="font-sans text-sky-300">
                                    解鎖新秘境水域
                                  </span>
                                </>
                              )}
                            </div>

                            {!isCompleted && (
                              <button
                                type="button"
                                disabled={!isReady}
                                onClick={() => onClaimQuest(quest.id)}
                                className={`px-4 py-2 rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
                                  isReady
                                    ? 'bg-amber-400 hover:bg-amber-300 text-slate-950 cursor-pointer'
                                    : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                                }`}
                              >
                                {isReady ? '領取委託回報' : '委託進行中'}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ==================== 2. TACKLE FORGE WORKSHOP ==================== */}
          {activeTab === 'workshop' && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h3 className="font-display text-xl font-bold text-slate-50">
                    玄伯的湖畔鍛造工坊
                  </h3>
                  <p className="text-sm text-slate-400 mt-0.5">
                    升級釣竿、捲線器、釣線與傳說擬餌，大幅提升拋投距離、控線容錯與守護魚王現身率
                  </p>
                </div>

                <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-900 border border-white/10">
                  {[
                    { id: 'rod' as const, label: '釣竿' },
                    { id: 'reel' as const, label: '捲線器' },
                    { id: 'line' as const, label: '釣線' },
                    { id: 'lure' as const, label: '擬餌' },
                  ].map((cat) => (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setWorkshopCategory(cat.id)}
                      className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                        workshopCategory === cat.id
                          ? 'bg-slate-100 text-slate-950'
                          : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {workshopCategory === 'rod' &&
                  RODS.map((rod) => {
                    const owned = save.ownedRods.includes(rod.id);
                    const equipped = save.equippedRodId === rod.id;
                    const canAfford =
                      save.gold >= rod.costGold && save.pearls >= rod.costPearls;
                    return (
                      <div
                        key={rod.id}
                        className={`rounded-xl border p-5 flex flex-col justify-between ${
                          equipped
                            ? 'bg-teal-950/30 border-teal-400/50'
                            : 'bg-[#101b2d] border-white/10'
                        }`}
                      >
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2.5">
                              <span
                                className="w-3.5 h-3.5 rounded-sm border border-white/25 shrink-0"
                                style={{ backgroundColor: numHexToCss(rod.accentColor) }}
                              />
                              <h4 className="font-display text-lg font-bold text-slate-100">
                                {rod.name}
                              </h4>
                            </div>
                            <span className="text-xs font-mono tabular-nums text-slate-400">
                              階級 T{rod.tier}
                            </span>
                          </div>
                          <p className="text-sm text-slate-300 mt-2 mb-4 leading-relaxed">
                            {rod.description}
                          </p>
                          <div className="flex flex-wrap items-center gap-2 text-xs font-mono tabular-nums text-sky-300 mb-4">
                            <span>遠投 {rod.maxCastDist}m</span>
                            <span aria-hidden="true" className="text-slate-600">·</span>
                            <span>緩衝 {Math.round(rod.tensionBuffer * 100)}%</span>
                            <span aria-hidden="true" className="text-slate-600">·</span>
                            <span>安全區拓寬 +{rod.safeZoneBonus}%</span>
                          </div>
                        </div>

                        <div className="flex items-center justify-between pt-3 border-t border-white/8">
                          <div className="text-xs font-mono tabular-nums text-slate-300">
                            {owned
                              ? '已擁有'
                              : `${rod.costGold} 金幣 · ${rod.costPearls} 水靈珠`}
                          </div>
                          <button
                            type="button"
                            disabled={equipped || (!owned && !canAfford)}
                            onClick={() => onBuyOrEquipRod(rod.id)}
                            className={`px-4 py-2 rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
                              equipped
                                ? 'bg-teal-500/20 text-teal-300 cursor-default'
                                : owned
                                  ? 'bg-slate-100 hover:bg-white text-slate-950 cursor-pointer'
                                  : canAfford
                                    ? 'bg-teal-400 hover:bg-teal-300 text-slate-950 cursor-pointer'
                                    : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                            }`}
                          >
                            {equipped ? '裝備中' : owned ? '裝備此竿' : '鍛造購買'}
                          </button>
                        </div>
                      </div>
                    );
                  })}

                {workshopCategory === 'reel' &&
                  REELS.map((reel) => {
                    const owned = save.ownedReels.includes(reel.id);
                    const equipped = save.equippedReelId === reel.id;
                    const canAfford =
                      save.gold >= reel.costGold && save.pearls >= reel.costPearls;
                    return (
                      <div
                        key={reel.id}
                        className={`rounded-xl border p-5 flex flex-col justify-between ${
                          equipped
                            ? 'bg-teal-950/30 border-teal-400/50'
                            : 'bg-[#101b2d] border-white/10'
                        }`}
                      >
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2.5">
                              <span
                                className="w-3.5 h-3.5 rounded-sm border border-white/25 shrink-0"
                                style={{ backgroundColor: numHexToCss(reel.spoolColor) }}
                              />
                              <h4 className="font-display text-lg font-bold text-slate-100">
                                {reel.name}
                              </h4>
                            </div>
                            <span className="text-xs font-mono tabular-nums text-slate-400">
                              階級 T{reel.tier}
                            </span>
                          </div>
                          <p className="text-sm text-slate-300 mt-2 mb-4 leading-relaxed">
                            {reel.description}
                          </p>
                          <div className="flex flex-wrap items-center gap-2 text-xs font-mono tabular-nums text-sky-300 mb-4">
                            <span>收線速度 {reel.reelSpeed.toFixed(1)}m/s</span>
                            <span aria-hidden="true" className="text-slate-600">·</span>
                            <span>體力消耗 {Math.round(reel.staminaDrain * 100)}%</span>
                            <span aria-hidden="true" className="text-slate-600">·</span>
                            <span>卸力穩定 {Math.round(reel.dragSmoothness * 100)}%</span>
                          </div>
                        </div>

                        <div className="flex items-center justify-between pt-3 border-t border-white/8">
                          <div className="text-xs font-mono tabular-nums text-slate-300">
                            {owned
                              ? '已擁有'
                              : `${reel.costGold} 金幣 · ${reel.costPearls} 水靈珠`}
                          </div>
                          <button
                            type="button"
                            disabled={equipped || (!owned && !canAfford)}
                            onClick={() => onBuyOrEquipReel(reel.id)}
                            className={`px-4 py-2 rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
                              equipped
                                ? 'bg-teal-500/20 text-teal-300 cursor-default'
                                : owned
                                  ? 'bg-slate-100 hover:bg-white text-slate-950 cursor-pointer'
                                  : canAfford
                                    ? 'bg-teal-400 hover:bg-teal-300 text-slate-950 cursor-pointer'
                                    : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                            }`}
                          >
                            {equipped ? '裝備中' : owned ? '裝備此輪' : '鍛造購買'}
                          </button>
                        </div>
                      </div>
                    );
                  })}

                {workshopCategory === 'line' &&
                  LINES.map((line) => {
                    const owned = save.ownedLines.includes(line.id);
                    const equipped = save.equippedLineId === line.id;
                    const canAfford =
                      save.gold >= line.costGold && save.pearls >= line.costPearls;
                    return (
                      <div
                        key={line.id}
                        className={`rounded-xl border p-5 flex flex-col justify-between ${
                          equipped
                            ? 'bg-teal-950/30 border-teal-400/50'
                            : 'bg-[#101b2d] border-white/10'
                        }`}
                      >
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <h4 className="font-display text-lg font-bold text-slate-100">
                              {line.name}
                            </h4>
                            <span className="text-xs font-mono tabular-nums text-slate-400">
                              拉力值 {line.testKg} kg
                            </span>
                          </div>
                          <p className="text-sm text-slate-300 mt-2 mb-4 leading-relaxed">
                            {line.description}
                          </p>
                          <div className="text-xs font-mono tabular-nums text-sky-300 mb-4">
                            抗斷線韌性加成 {Math.round(line.maxTensionLimit * 100)}%
                          </div>
                        </div>

                        <div className="flex items-center justify-between pt-3 border-t border-white/8">
                          <div className="text-xs font-mono tabular-nums text-slate-300">
                            {owned
                              ? '已擁有'
                              : `${line.costGold} 金幣 · ${line.costPearls} 水靈珠`}
                          </div>
                          <button
                            type="button"
                            disabled={equipped || (!owned && !canAfford)}
                            onClick={() => onBuyOrEquipLine(line.id)}
                            className={`px-4 py-2 rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
                              equipped
                                ? 'bg-teal-500/20 text-teal-300 cursor-default'
                                : owned
                                  ? 'bg-slate-100 hover:bg-white text-slate-950 cursor-pointer'
                                  : canAfford
                                    ? 'bg-teal-400 hover:bg-teal-300 text-slate-950 cursor-pointer'
                                    : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                            }`}
                          >
                            {equipped ? '裝備中' : owned ? '換上此線' : '購買釣線'}
                          </button>
                        </div>
                      </div>
                    );
                  })}

                {workshopCategory === 'lure' &&
                  LURES.map((lure) => {
                    const owned = save.ownedLures.includes(lure.id);
                    const equipped = save.equippedLureId === lure.id;
                    const canAfford =
                      save.gold >= lure.costGold && save.pearls >= lure.costPearls;
                    return (
                      <div
                        key={lure.id}
                        className={`rounded-xl border p-5 flex flex-col justify-between ${
                          equipped
                            ? 'bg-teal-950/30 border-teal-400/50'
                            : 'bg-[#101b2d] border-white/10'
                        }`}
                      >
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2.5">
                              <span
                                className="w-3.5 h-3.5 rounded-sm border border-white/25 shrink-0"
                                style={{ backgroundColor: numHexToCss(lure.bobberTopColor) }}
                              />
                              <h4 className="font-display text-lg font-bold text-slate-100">
                                {lure.name}
                              </h4>
                            </div>
                          </div>
                          <div className="text-xs text-amber-300/90 mt-1.5">
                            {lure.targetHint}
                          </div>
                          <p className="text-sm text-slate-300 mt-2 mb-4 leading-relaxed">
                            {lure.description}
                          </p>
                          <div className="flex flex-wrap items-center gap-2 text-xs font-mono tabular-nums text-sky-300 mb-4">
                            <span>咬餌加速 {lure.biteSpeedBonus.toFixed(2)}x</span>
                            <span aria-hidden="true" className="text-slate-600">·</span>
                            <span>珍稀加成 {lure.rareWeightBonus.toFixed(2)}x</span>
                            <span aria-hidden="true" className="text-slate-600">·</span>
                            <span>魚王吸引 {lure.guardianBonus.toFixed(2)}x</span>
                          </div>
                        </div>

                        <div className="flex items-center justify-between pt-3 border-t border-white/8">
                          <div className="text-xs font-mono tabular-nums text-slate-300">
                            {owned
                              ? '已擁有'
                              : `${lure.costGold} 金幣 · ${lure.costPearls} 水靈珠`}
                          </div>
                          <button
                            type="button"
                            disabled={equipped || (!owned && !canAfford)}
                            onClick={() => onBuyOrEquipLure(lure.id)}
                            className={`px-4 py-2 rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
                              equipped
                                ? 'bg-teal-500/20 text-teal-300 cursor-default'
                                : owned
                                  ? 'bg-slate-100 hover:bg-white text-slate-950 cursor-pointer'
                                  : canAfford
                                    ? 'bg-teal-400 hover:bg-teal-300 text-slate-950 cursor-pointer'
                                    : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                            }`}
                          >
                            {equipped ? '使用中' : owned ? '掛上此餌' : '調配購買'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}

          {/* ==================== 3. ECOLOGICAL 3D COMPENDIUM ==================== */}
          {activeTab === 'encyclopedia' && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* Left Column: Zone Filter + Species Grid */}
              <div className="lg:col-span-7 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="font-display text-xl font-bold text-slate-50">
                      澪的水鏡生態圖鑑
                    </h3>
                    <p className="text-xs text-slate-400 font-mono tabular-nums mt-0.5">
                      已登錄物種 {discoveredTotal} / {FISH_SPECIES.length}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-1 p-1 rounded-xl bg-slate-900 border border-white/10">
                    <button
                      type="button"
                      onClick={() => setEncZoneFilter('all')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                        encZoneFilter === 'all'
                          ? 'bg-slate-100 text-slate-950 font-semibold'
                          : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      全部水域
                    </button>
                    {WATER_ZONES.map((z) => (
                      <button
                        key={z.id}
                        type="button"
                        onClick={() => setEncZoneFilter(z.id)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                          encZoneFilter === z.id
                            ? 'bg-slate-100 text-slate-950 font-semibold'
                            : 'text-slate-300 hover:text-white'
                        }`}
                      >
                        {z.name.slice(0, 4)}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {filteredSpecies.map((sp) => {
                    const st = save.speciesStats[sp.id];
                    const unlocked = Boolean(st && st.count > 0);
                    const selected = inspectedSpecies.id === sp.id;
                    return (
                      <button
                        key={sp.id}
                        type="button"
                        onClick={() => setSelectedSpeciesId(sp.id)}
                        className={`text-left rounded-xl p-4 border transition-colors cursor-pointer ${
                          selected
                            ? 'bg-[#15253d] border-teal-400/60'
                            : 'bg-[#0f1928] border-white/8 hover:border-white/20'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 text-xs mb-1">
                          <span style={{ color: unlocked ? sp.color : '#64748b' }}>
                            {sp.rarityLabel}
                          </span>
                          <span className="font-mono tabular-nums text-slate-400">
                            {unlocked ? `捕獲 ${st.count} 尾` : '尚未發現'}
                          </span>
                        </div>
                        <div className="font-display text-base font-bold text-slate-100">
                          {unlocked ? sp.name : '？？？未知水棲物種'}
                        </div>
                        <div className="text-xs text-slate-400 mt-1 font-mono tabular-nums">
                          {unlocked
                            ? `最大紀錄 ${st.bestWeight.toFixed(2)} kg · ${st.bestLength.toFixed(1)} cm`
                            : `棲息地：${WATER_ZONES.find((z) => z.id === sp.zoneId)?.name ?? ''}`}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Right Column: Live 360° 3D Fish Specimen Inspector */}
              <div className="lg:col-span-5 rounded-xl bg-[#101b2d] border border-white/10 p-5 space-y-4">
                <FishPreview3D species={inspectedSpecies} unlocked={isInspectedUnlocked} />

                <div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 mb-1">
                    <span style={{ color: inspectedSpecies.color }}>
                      {inspectedSpecies.rarityLabel}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {WATER_ZONES.find((z) => z.id === inspectedSpecies.zoneId)?.name}
                    </span>
                    {inspectedSpecies.isGuardian && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-amber-300">水域守護靈主</span>
                      </>
                    )}
                  </div>

                  <h4 className="font-display text-2xl font-bold text-slate-50">
                    {isInspectedUnlocked ? inspectedSpecies.name : '未解鎖的神秘魚影'}
                  </h4>
                  <p className="text-xs italic text-slate-400 mt-0.5">
                    {isInspectedUnlocked ? inspectedSpecies.latinName : 'Species incognita'}
                  </p>
                </div>

                {isInspectedUnlocked && inspectedStats ? (
                  <div className="grid grid-cols-3 gap-3 py-3 border-y border-white/10 text-xs font-mono tabular-nums">
                    <div>
                      <div className="text-slate-400 font-sans">累計釣獲</div>
                      <div className="text-base font-semibold text-slate-100 mt-0.5">
                        {inspectedStats.count} 尾
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-400 font-sans">最大體重</div>
                      <div className="text-base font-semibold text-sky-300 mt-0.5">
                        {inspectedStats.bestWeight.toFixed(2)} kg
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-400 font-sans">最長體長</div>
                      <div className="text-base font-semibold text-teal-300 mt-0.5">
                        {inspectedStats.bestLength.toFixed(1)} cm
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="py-3 border-y border-white/10 text-xs text-slate-400 space-y-1">
                    <div>
                      出沒時段：
                      {inspectedSpecies.preferredTime
                        ? inspectedSpecies.preferredTime.map((t) => TIME_LABELS[t]).join(' / ')
                        : '全時段皆有機率出沒'}
                    </div>
                    <div>
                      偏好天候：
                      {inspectedSpecies.preferredWeather
                        ? inspectedSpecies.preferredWeather
                            .map((w) => WEATHER_LABELS[w])
                            .join(' / ')
                        : '不限天候'}
                    </div>
                  </div>
                )}

                <p className="text-sm text-slate-300 leading-relaxed">
                  {isInspectedUnlocked
                    ? inspectedSpecies.lore
                    : '此魚種仍隱身於水鏡迷霧之中。試著根據上方的生態時段與天候線索，搭配高階擬餌進行遠投探索吧。'}
                </p>
              </div>
            </div>
          )}

          {/* ==================== 4. WORLD ZONES & ATMOSPHERE ==================== */}
          {activeTab === 'world' && (
            <div className="space-y-6">
              {/* Time of Day & Weather Selectors */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="rounded-xl bg-[#101b2d] border border-white/10 p-4">
                  <div className="text-xs text-slate-400 mb-2.5">
                    天光時段切換（即時連動天空散射與特定魚種活躍度）
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {(['dawn', 'dusk', 'night'] as TimeOfDay[]).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => onChangeTimeOfDay(t)}
                        className={`py-2 px-3 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                          save.timeOfDay === t
                            ? 'bg-amber-400 text-slate-950'
                            : 'bg-slate-800/90 text-slate-200 hover:bg-slate-700'
                        }`}
                      >
                        {TIME_LABELS[t]}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="rounded-xl bg-[#101b2d] border border-white/10 p-4">
                  <div className="text-xs text-slate-400 mb-2.5">
                    氣候水文切換（改變雨滴漣漪、靈霧濃度與水聲環境音）
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {(['clear', 'rain', 'mist'] as WeatherType[]).map((w) => (
                      <button
                        key={w}
                        type="button"
                        onClick={() => onChangeWeather(w)}
                        className={`py-2 px-3 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                          save.weather === w
                            ? 'bg-sky-400 text-slate-950'
                            : 'bg-slate-800/90 text-slate-200 hover:bg-slate-700'
                        }`}
                      >
                        {WEATHER_LABELS[w]}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* 4 Illustrated Sanctuary Water Zones */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {WATER_ZONES.map((zone) => {
                  const isUnlocked = save.unlockedZones.includes(zone.id);
                  const isCurrent = save.currentZoneId === zone.id;
                  const canUnlock =
                    save.gold >= zone.unlockGold &&
                    save.guardianScales.length >= zone.unlockScaleCount;
                  const zoneSpecies = FISH_SPECIES.filter((f) => f.zoneId === zone.id);
                  const caughtInZone = zoneSpecies.filter(
                    (f) => (save.speciesStats[f.id]?.count ?? 0) > 0,
                  ).length;

                  return (
                    <div
                      key={zone.id}
                      className={`rounded-xl border overflow-hidden flex flex-col justify-between transition-colors ${
                        isCurrent
                          ? 'bg-[#122238] border-teal-400/60'
                          : 'bg-[#0f1928] border-white/10'
                      }`}
                    >
                      <div>
                        {/* Panoramic Oriental Fantasy Zone Illustration with Measured Scrim */}
                        <div className="relative h-44 w-full overflow-hidden">
                          <ResilientArtwork
                            src={zone.bannerUrl}
                            alt={zone.name}
                            fallbackLabel={zone.name}
                            fallbackGradient={zone.fallbackGradient}
                            className="w-full h-full"
                          />
                          <div className="absolute inset-0 bg-gradient-to-t from-[#0f1928] via-[#0f1928]/40 to-transparent" />
                          <div className="absolute bottom-3 left-4 right-4 flex items-end justify-between gap-2">
                            <div>
                              <div className="text-xs text-teal-200 font-medium drop-shadow">
                                {zone.subtitle}
                              </div>
                              <h4 className="font-display text-xl font-bold text-white drop-shadow">
                                {zone.name}
                              </h4>
                            </div>
                            {!isUnlocked && (
                              <Lock className="w-4 h-4 text-amber-300 shrink-0 mb-1" />
                            )}
                          </div>
                        </div>

                        <div className="p-5 pb-4">
                          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 font-mono tabular-nums mb-3">
                            <span>水深 {zone.depthText}</span>
                            <span aria-hidden="true">·</span>
                            <span className="font-sans">魚群活性：{zone.activityText}</span>
                            <span aria-hidden="true">·</span>
                            <span>
                              圖鑑 {caughtInZone}/{zoneSpecies.length}
                            </span>
                          </div>
                          <p className="text-sm text-slate-300 leading-relaxed">{zone.lore}</p>
                        </div>
                      </div>

                      <div className="px-5 py-3.5 border-t border-white/8 flex items-center justify-between gap-3">
                        <div className="text-xs font-mono tabular-nums text-slate-300">
                          {isUnlocked
                            ? '秘境航線已開啟'
                            : `需 ${zone.unlockGold} 金幣 · ${zone.unlockScaleCount} 枚守護聖鱗`}
                        </div>

                        <button
                          type="button"
                          disabled={isCurrent || (!isUnlocked && !canUnlock)}
                          onClick={() => onUnlockOrTravelZone(zone.id)}
                          className={`px-4 py-2 rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
                            isCurrent
                              ? 'bg-teal-500/20 text-teal-300 cursor-default'
                              : isUnlocked
                                ? 'bg-slate-100 hover:bg-white text-slate-950 cursor-pointer'
                                : canUnlock
                                  ? 'bg-amber-400 hover:bg-amber-300 text-slate-950 cursor-pointer'
                                  : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                          }`}
                        >
                          {isCurrent
                            ? '當前所在水域'
                            : isUnlocked
                              ? '前往此水域'
                              : '解鎖並前往'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ==================== 5. MULTI-SLOT SAVES & AUDIO ==================== */}
          {activeTab === 'saves' && (
            <div className="space-y-6">
              <div className="rounded-xl bg-[#101b2d] border border-white/10 p-5 flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h4 className="font-display text-lg font-bold text-slate-100">
                    即時合成自然水聲與療癒配樂
                  </h4>
                  <p className="text-sm text-slate-400 mt-0.5">
                    透過 Web Audio API 即時演算湖波拍岸、煙雨聲與五聲音階空靈弦音
                  </p>
                </div>

                <button
                  type="button"
                  onClick={onToggleMute}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-white/12 text-sm font-medium whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {isMuted ? (
                    <>
                      <VolumeX className="w-4 h-4 text-rose-400" />
                      <span>音訊已靜音（點擊開啟）</span>
                    </>
                  ) : (
                    <>
                      <Volume2 className="w-4 h-4 text-teal-300" />
                      <span>音訊播放中（點擊靜音）</span>
                    </>
                  )}
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {[1, 2, 3].map((slotNum) => {
                  const slotData = slotNum === save.slotId ? save : loadSlotData(slotNum);
                  const isCurrent = slotNum === save.slotId;
                  const dateStr = new Date(slotData.updatedAt).toLocaleString('zh-TW', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  });

                  return (
                    <div
                      key={slotNum}
                      className={`rounded-xl border p-5 flex flex-col justify-between ${
                        isCurrent
                          ? 'bg-teal-950/35 border-teal-400/50'
                          : 'bg-[#101b2d] border-white/10'
                      }`}
                    >
                      <div>
                        <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                          <span>本機存檔槽位 {slotNum}</span>
                          <span className="font-mono tabular-nums">{dateStr}</span>
                        </div>
                        <div className="font-display text-lg font-bold text-slate-100">
                          {slotData.playerTitle}
                        </div>
                        <div className="text-xs text-slate-300 mt-2 space-y-1 font-mono tabular-nums">
                          <div>
                            第 {slotData.storyChapter} 章 · 漁獲 {slotData.totalCount} 尾
                          </div>
                          <div>
                            {slotData.gold} 金幣 · {slotData.pearls} 水靈珠
                          </div>
                        </div>
                      </div>

                      <div className="mt-4 pt-3 border-t border-white/8 flex items-center justify-between gap-2">
                        <button
                          type="button"
                          disabled={isCurrent}
                          onClick={() => onSwitchSlot(slotNum)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer ${
                            isCurrent
                              ? 'bg-teal-500/20 text-teal-300 cursor-default'
                              : 'bg-slate-100 hover:bg-white text-slate-950'
                          }`}
                        >
                          {isCurrent ? '使用中' : '切換至此槽'}
                        </button>

                        {confirmResetSlot === slotNum ? (
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                onResetSlot(slotNum);
                                setConfirmResetSlot(null);
                              }}
                              className="px-2.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold whitespace-nowrap cursor-pointer"
                            >
                              確定重置
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmResetSlot(null)}
                              className="px-2 py-1.5 rounded-lg bg-slate-800 text-slate-300 text-xs whitespace-nowrap cursor-pointer"
                            >
                              取消
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmResetSlot(slotNum)}
                            className="text-xs text-slate-400 hover:text-rose-300 transition-colors whitespace-nowrap cursor-pointer"
                          >
                            重置進度
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Hardened Save Code Backup Export / Import */}
              <div className="rounded-xl bg-[#101b2d] border border-white/10 p-5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h4 className="text-sm font-semibold text-slate-100">
                      跨裝置安全存檔碼備份與還原
                    </h4>
                    <p className="text-xs text-slate-400">
                      內建白名單結構驗證與數值防呆保護，支援相容舊版與新版 EMV2 備份編碼
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleCopyExport}
                    className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-white/10 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    <span>複製當前槽位存檔碼</span>
                  </button>
                </div>

                <div className="flex gap-2">
                  <input
                    type="text"
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                    placeholder="貼上備份存檔碼以安全驗證並還原至當前槽位..."
                    className="flex-1 rounded-lg bg-[#080e18] border border-white/12 px-3 py-2 text-xs font-mono text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-teal-400"
                  />
                  <button
                    type="button"
                    onClick={handleRunImport}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-teal-400 hover:bg-teal-300 text-slate-950 text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    <span>匯入存檔</span>
                  </button>
                </div>

                {copyStatus && (
                  <p
                    className={`text-xs ${
                      copyStatus.ok ? 'text-teal-300' : 'text-rose-300'
                    }`}
                  >
                    {copyStatus.text}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
