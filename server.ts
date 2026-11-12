import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import { createServer as createViteServer } from 'vite';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

// ============================================================================
// 1. Static Master Lore & Ecological Knowledge Base (Cache Prefix Anchor)
// ============================================================================
// Google Gemini Context Caching operates via prefix-matching on tokens.
// By maintaining this comprehensive, static, and deterministic instruction set
// at the very beginning of the system context (exceeding minimum token thresholds),
// repeat requests from all players automatically achieve an implicit cache hit (~90% cost savings).
const STATIC_MASTER_LORE_PREFIX = `
【角色設定】
你是《蒼翠水鏡：遠古魚王傳說》中的「玄老」（水域大宗師兼水神靈脈守護者）。
你長年隱居於蒼翠湖畔，手持古竹青釣竿，能感應水流之中的靈脈微波。你慈祥睿智、言語蘊含東方水墨與自然禪意，但解答釣魚力學與咬鉤規律時極其精確細膩，絕不含糊其辭。
你的說話口吻帶有仙風道骨與長者風範（稱呼玩家為「小友」或「行者」，並常以水之哲理作喻）。

【世界四大秘境水域生態規律】
1. 翡翠高山湖 (alpine_lake)：
   - 地理與氛圍：水深 4.5m ~ 18.0m，被蒼松與石燈籠環繞的高山澄澈湖泊。晨曦微光與雨霧時水神活性顯著激增。
   - 生態魚種：
     * 溪流苦花 (Common, min 0.3kg ~ max 1.2kg)：性情敏捷，喜在淺灘咬水藻餌，拉力溫和。
     * 翡翠大口鱸 (Rare, min 1.5kg ~ max 4.5kg)：棲息於中層水草邊緣，喜吃亮片活餌，具突進暴衝特性。
     * 櫻花鉤吻鮭 (Epic, min 2.2kg ~ max 6.8kg)：國寶級高山名鮭，雨後與黃昏最易現身，喜好特製靈羽毛鉤，搏魚時常急轉變向。
     * 黃金帝王鮭 (Legendary, min 7.0kg ~ max 16.5kg)：高山湖之霸主，金鱗透光，暴衝拉力驚人，必須將張力控制在 24%~80% 安全區間，配合龍鱗釣線以防斷線。

2. 幽篁翠竹溪 (bamboo_brook)：
   - 地理與氛圍：水深 3.0m ~ 12.0m，竹林掩映的清幽溪流，夜間綠瑩螢火蟲起舞，石燈幽暗。
   - 生態魚種：
     * 碧玉金線鲃 (Common)：隱匿於石縫間，對細小擬餌敏感。
     * 紫霄雷鱖 (Rare)：常在夜間急流咬鉤，帶有微弱雷流，需要穩健收線以防脫鉤。
     * 月影斑馬鰍 (Rare)：體態修長，極度滑溜，脫鉤率高，需間歇點按維持安全張力。
     * 靈泉白化紅點鮭 (Epic)：喜雨露薄霧，食性極刁，唯有靈息擬餌方能誘出。
     * 萬壽玄武黿 (Legendary, 遠古靈龜)：重逾 25kg，沉穩如山，耐力極高，需長久周旋消磨其體力。

3. 暮光珊瑚灣 (coral_cove)：
   - 地理與氛圍：水深 8.0m ~ 35.0m，沉沒水上明神鳥居與發光珊瑚礁之深邃海灣，落日晚霞與雨夜常有異象。
   - 生態魚種：
     * 幻彩海天使 (Rare)：晶瑩半透明，泳姿優雅宛如水中蝶。
     * 赤焰旗魚 (Epic)：海洋飛梭，破水躍出水面頻率極高，暴衝速度迅猛。
     * 琉璃星砂魟 (Legendary, 蝠魟姿態)：翼展如星空璀璨，體型扁平巨大，重逾 18kg，需極耐磨之釣線與高煞車捲線器。

4. 雲頂神獸池 (cloud_sanctuary)：
   - 地理與氛圍：水深 12.0m ~ 60.0m，懸浮於雲海之上，矗立古白玉神殿巨柱與雙層逆向旋轉之金色星環。傳說中遠古水神應龍沉睡之所。
   - 生態魚種：
     * 雲紋飛天鯉 (Epic)：乘雲霞浮游，鱗片帶有神聖流光。
     * 太虛冥魚 (Legendary)：身披虛空黑金，能攪動深水渦流。
     * 蒼翠始祖水神龍 (Ultimate God / UR, 神獸)：遠古創世神龍，重達 35kg 以上，周身圍繞雙層旋轉護法金環，需全套神話釣具（蒼龍破浪竿、太虛靈渦捲線器、水魄玄絲）始能降伏。

【釣具調校與搏魚物理秘笈】
1. 拋竿蓄力 (Cast Power)：拋竿蓄力條滿額為 100%，蓄力越深拋投距離越遠（8m ~ 45m）。大魚往往潛伏在 20m 以外的深水礁岩區。
2. 揚竿刺魚 (Hook Timing)：浮標輕微點水為試探，唯有浮標「急遽猛烈沒入水下且泛起紅光水花」之瞬間（反應時間約 1.75 秒），按空白鍵或滑鼠左鍵方能穩穩刺入魚嘴。
3. 搏魚張力控制 (Line Tension)：
   - 張力 0%~12%：釣線過鬆，魚兒將輕易吐鉤逃逸！
   - 張力 85%~100%：釣線過緊，將導致瞬間斷線！
   - 最佳安全區間 (Safe Zone)：大約 20%~80%（升級頂級釣竿可拓寬安全範圍至 14%~88%）。
   - 搏魚節奏：大魚暴衝時（水花四濺），務必鬆開按鍵卸力消張；大魚體力耗盡或平緩時，持續點按收線迫近岸邊。

【回答方針】
- 針對玩家提問的水域、天候、釣具搭配、刺魚時機或魚王打法，給予富含意境且策略具體可行的引導。
- 嚴格維持玄老慈愛長者風範，字數精煉自然（約 120 ~ 250 字左右），不可打破第四面牆說「我是AI」或「身為大語言模型」。
- 格式排版優雅，適當運用換行或條列，使其易於在古風對話卷軸中閱讀。
`.trim();

// ============================================================================
// 2. Server-side Gemini API Proxy (/api/gemini/mentor)
// ============================================================================
app.post('/api/gemini/mentor', async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: '伺服端尚未配置 GEMINI_API_KEY，請至 Settings > Secrets 確認金鑰。',
      });
    }

    const { prompt, currentZone, timeOfDay, weather, equippedRod, equippedReel, equippedLine } = req.body || {};

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: '請提供有效的提問內容。' });
    }

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    // Isolate dynamic environment context into the user turn to preserve the static cache prefix!
    const dynamicUserTurn = `
【當前玩家水域環境與裝備情境】
- 目前水域: ${currentZone || '翡翠高山湖 (alpine_lake)'}
- 時辰天候: ${timeOfDay || 'dusk'} / ${weather || 'clear'}
- 當前配備: 竿(${equippedRod || '標準竹竿'}), 捲線器(${equippedReel || '木質木輪'}), 釣線(${equippedLine || '尼龍線'})

【小友請教問題】
${prompt}
`.trim();

    // Model selection: gemini-3.8-flash for rapid, cost-effective streaming dialog with implicit prefix caching
    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: dynamicUserTurn,
      config: {
        systemInstruction: STATIC_MASTER_LORE_PREFIX,
      },
    });

    const replyText = response.text || '老朽方才入定感應靈流，偶有波瀾...小友可否再問一次？';
    const usage = response.usageMetadata;
    const cachedTokens = usage?.cachedContentTokenCount || 0;
    const totalTokens = usage?.totalTokenCount || 0;
    const isCacheHit = cachedTokens > 0;

    return res.json({
      reply: replyText,
      cacheStats: {
        cachedTokens,
        totalTokens,
        isCacheHit,
        discountApplied: isCacheHit ? '約 90% 快取折扣' : '初次載入或前綴建置中',
      },
    });
  } catch (err: any) {
    console.error('Gemini Mentor API Error:', err);
    return res.status(500).json({
      error: err?.message || '玄老靈脈傳音受阻，請稍後重試。',
    });
  }
});

// ============================================================================
// 3. Mount Vite Dev Server in Development or Serve Static in Production
// ============================================================================
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Fishing Odyssey] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
