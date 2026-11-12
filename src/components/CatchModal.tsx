import { useEffect } from 'react';
import { CaughtFishInstance } from '../types/game';
import { WATER_ZONES } from '../data/gameData';

interface CatchModalProps {
  caught: CaughtFishInstance | null;
  alreadyHasScale: boolean;
  onResolve: (action: 'keep' | 'release') => void;
}

export function CatchModal({ caught, alreadyHasScale, onResolve }: CatchModalProps) {
  useEffect(() => {
    if (!caught) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        onResolve('keep');
      } else if (e.code === 'KeyR') {
        e.preventDefault();
        onResolve('release');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [caught, onResolve]);

  if (!caught) return null;

  const { species, weight, length, goldValue, pearlValue, isNewSpecies, isNewRecord } = caught;
  const releaseGold = Math.max(10, Math.round(goldValue * 0.45));
  const releasePearls = pearlValue * 2 + 1;
  const zoneName = WATER_ZONES.find((z) => z.id === species.zoneId)?.name ?? '秘境水域';

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-end md:pr-14 px-4 pointer-events-auto bg-slate-950/35">
      <div className="w-full max-w-md rounded-2xl bg-[#0b1320]/96 border border-white/14 p-7 shadow-2xl text-slate-100">
        {/* Clean unboxed metadata kicker with typographic separators */}
        <div className="flex flex-wrap items-center gap-2 text-xs font-medium tracking-wide text-slate-300 mb-2">
          <span style={{ color: species.color }}>{species.rarityLabel}</span>
          <span aria-hidden="true" className="text-slate-600">·</span>
          <span className="text-slate-400">{zoneName}</span>
          {isNewSpecies && (
            <>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span className="text-teal-300">首次登錄新圖鑑</span>
            </>
          )}
          {!isNewSpecies && isNewRecord && (
            <>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span className="text-amber-300">刷新個人最大紀錄</span>
            </>
          )}
        </div>

        <h2 className="font-display text-3xl font-bold text-slate-50 tracking-tight">
          {species.name}
        </h2>
        <p className="text-xs italic text-slate-400 mt-0.5 mb-5">{species.latinName}</p>

        {/* Quantitative Metrics in Tabular Numerals */}
        <div className="grid grid-cols-2 gap-4 py-4 border-y border-white/10 mb-5">
          <div>
            <div className="text-xs text-slate-400">實測重量</div>
            <div className="font-mono tabular-nums text-2xl font-semibold text-sky-300 mt-0.5">
              {weight.toFixed(2)} <span className="text-sm font-normal text-slate-400">kg</span>
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-400">實測體長</div>
            <div className="font-mono tabular-nums text-2xl font-semibold text-teal-300 mt-0.5">
              {length.toFixed(1)} <span className="text-sm font-normal text-slate-400">cm</span>
            </div>
          </div>
        </div>

        <p className="text-sm text-slate-300 leading-relaxed mb-5">{species.lore}</p>

        {species.isGuardian && species.scaleItemName && !alreadyHasScale && (
          <div className="rounded-xl bg-amber-500/10 border border-amber-400/30 px-4 py-3 mb-5 text-sm text-amber-200">
            獲得傳說信物：<span className="font-semibold text-amber-300">{species.scaleItemName}</span>
            <p className="text-xs text-amber-200/80 mt-0.5">
              古老水脈產生共鳴，無論收入魚護或放流皆會永久保存此聖鱗。
            </p>
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-3">
          <button
            type="button"
            onClick={() => onResolve('keep')}
            className="flex-1 rounded-xl bg-teal-400 hover:bg-teal-300 text-slate-950 font-semibold py-3 px-4 text-sm transition-colors cursor-pointer"
          >
            <div className="whitespace-nowrap">收入魚護 [Space]</div>
            <div className="font-mono tabular-nums text-xs font-medium opacity-85 mt-0.5 whitespace-nowrap">
              +{goldValue} 金幣 · +{pearlValue} 水靈珠
            </div>
          </button>

          <button
            type="button"
            onClick={() => onResolve('release')}
            className="flex-1 rounded-xl bg-slate-800/95 hover:bg-slate-700/95 border border-white/12 text-slate-100 font-semibold py-3 px-4 text-sm transition-colors cursor-pointer"
          >
            <div className="whitespace-nowrap">放流祈福 [R]</div>
            <div className="font-mono tabular-nums text-xs text-teal-300 font-medium mt-0.5 whitespace-nowrap">
              +{releaseGold} 金幣 · +{releasePearls} 水靈珠
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
