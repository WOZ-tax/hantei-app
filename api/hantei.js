// /api/hantei.js
import fetch from 'node-fetch';

// Vercelのサーバーレス関数のエントリーポイント
export default async function handler(req, res) {
  // POSTリクエスト以外は405エラーを返す
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  // Vercelの環境変数からAPIキーを取得
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'APIキーがサーバーに設定されていません。' });
  }

  // リクエストボディから判定するテキストを取得
  const { tweetText } = req.body;
  if (!tweetText || typeof tweetText !== 'string' || tweetText.trim() === '') {
    return res.status(400).json({ error: '判定するテキストがありません。' });
  }
  
  const modelName = 'gemini-2.5-flash-lite-preview-06-17';
  
  // APIを呼び出すための共通ヘルパー関数
  const callApi = async (prompt) => {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
      const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { response_mime_type: "application/json" }
      };
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        console.error(`API Error: ${response.status}`, await response.text());
        return { error: `AIとの通信でエラーが発生しました (コード: ${response.status})。` };
      }
      const result = await response.json();
      const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;
      if (jsonText) return JSON.parse(jsonText);
      const blockReason = result.promptFeedback?.blockReason || "不明な理由";
      return { error: `AIが応答をブロックしました: ${blockReason}`};
    } catch (e) {
      console.error(`API Exception:`, e);
      return { error: `API通信で致命的なエラーが発生しました。` };
    }
  };

  // --- 1. リスク分析 ---
  const riskAnalysisPrompt = `# 指示\nあなたは、SNSの投稿内容を分析する専門家です。以下の投稿内容について、3つの観点（法的リスク、企業リスク、一般人の感情的な不快度）から分析し、その結果をJSON形式で出力してください。\n\n# 制約条件\n* あなたの回答は、有効なJSONオブジェクトのみを含むこと。\n* JSONオブジェクトの前後に、説明文や「はい、承知しました」などの余計なテキストは一切含めないでください。\n* 出力は必ず以下のキーを持つJSONオブジェクトとすること: "legal_risk", "corporate_risk", "emotional_discomfort", "reason"\n* 各リスクの値は「高」「中」「低」のいずれかであること。\n* 理由(reason)は50字以内で簡潔に記述すること。\n\n# 投稿内容\n"${tweetText}"`;
  const aiResult = await callApi(riskAnalysisPrompt);
  if (aiResult.error) return res.status(500).json(aiResult);

  // --- 2. 調整スコア分析 ---
  const adjustmentPrompt = `# 指示\nあなたは、SNS投稿の悪質度を分析する専門家です。以下の投稿内容に、キーワードだけでは判断できない、文脈上の悪意、皮肉、巧妙な侮辱、または逆に擁護や正当な批判といった要素が含まれているか評価してください。\n\n# 投稿内容\n"${tweetText}"\n\n# タスク\n各ペルソナの視点から、スコアに加えるべき「調整点」を-2から+2の整数で評価してください。\n* ポジティブな評価や正当な批判ならマイナス点。\n* 皮肉や巧妙な悪意が隠されていればプラス点。\n* 特に文脈的な要素がなければ0点。\n\n# 制約条件\n* あなたの回答は、有効なJSONオブジェクトのみを含むこと。\n* 出力は必ず以下のキーを持つJSONオブジェクトとすること: "bengo_adjust", "houmu_adjust", "onee_adjust"`;
  let adjustments = await callApi(adjustmentPrompt);
  if (adjustments.error) {
    console.error("Score adjustment failed:", adjustments.error);
    adjustments = { bengo_adjust: 0, houmu_adjust: 0, onee_adjust: 0 };
  }

  // --- 3. スコアリングと判定ロジック ---
  const riskToScore = { "高": 4, "中": 2, "低": 1 };
  let bengoPrimaryScore = riskToScore[aiResult.legal_risk] || 1;
  let houmuPrimaryScore = riskToScore[aiResult.corporate_risk] || 1;
  let oneePrimaryScore = riskToScore[aiResult.emotional_discomfort] || 1;
  
  const text = tweetText;
  if (/殺す|刺す|めった刺し|放火/.test(text)) { bengoPrimaryScore = 9; oneePrimaryScore = 10; houmuPrimaryScore += 4; }
  if (/死ね|生きる価値|犯罪者/.test(text)) { bengoPrimaryScore += 4; oneePrimaryScore += 5; houmuPrimaryScore += 2; }
  if (/違法|逮捕|前科|横領/.test(text)) { bengoPrimaryScore += 3; houmuPrimaryScore += 3; }
  if (/バカ|アホ|無能|キモい|頭が悪い|ブス|デブ|ハゲ|醜い|チビ/.test(text)) { oneePrimaryScore += 3; bengoPrimaryScore += 2; }
  if (/倒産|ブラック企業|隠蔽|パワハラ|セクハラ/.test(text)) { houmuPrimaryScore += 4; bengoPrimaryScore += 2; }
  if (aiResult.emotional_discomfort === "高") { oneePrimaryScore += 2; }
  
  const bengoScore = bengoPrimaryScore + (adjustments.bengo_adjust || 0);
  const houmuScore = houmuPrimaryScore + (adjustments.houmu_adjust || 0);
  const oneeScore = oneePrimaryScore + (adjustments.onee_adjust || 0);

  const getHantei = (score, sansei, chuuritsu) => (score >= sansei ? "開示に賛成" : score >= chuuritsu ? "中立" : "開示に反対");
  const hanteiFlags = {
      bengo: getHantei(bengoScore, 5, 3),
      houmu: getHantei(houmuScore, 5, 4),
      onee: getHantei(oneeScore, 5, 3)
  };
  
  // --- 4. コメント生成 ---
  const finalScores = { bengo_score: bengoScore, houmu_score: houmuScore, onee_score: oneeScore };
  const commentPrompt = `# 指示\nあなたは、SNSの投稿を分析する3人の専門家（ネットに強い弁護士、プライム企業法務部、辛口オネエ）の思考をシミュレートするAIです。\n以下の情報に基づき、3人のペルソナのコメントを生成してください。\n\n# ペルソナ設定\n* **ネットに強い弁護士**: 法律用語を交えつつ、開示請求の可能性を冷静に分析する。賛成の場合は法的根拠を、中立の場合は争点を、反対の場合はその理由を力強くコメントすること。\n* **プライム企業法務部**: 企業のリスク管理を最優先。冷静かつ慎重に判断する。\n* **辛口オネエ**: 口は悪いが、社会的正義感は強いご意見番。「人として許されるか」を基準に、悪質な投稿は積極的に開示請求すべきだと考える。\n\n# 投稿内容\n"${tweetText}"\n\n# 事前分析のサマリー\n${aiResult.reason} (法的リスク:${aiResult.legal_risk}, 企業リスク:${aiResult.corporate_risk}, 感情的不快度:${aiResult.emotional_discomfort})\n\n# 各ペルソナの最終判断（結論）\n* ネットに強い弁護士: ${hanteiFlags.bengo} (賛成/中立/反対)\n* プライム企業法務部: ${hanteiFlags.houmu} (賛成/中立/反対)\n* 辛口オネエ: ${hanteiFlags.onee} (賛成/中立/反対)\n\n# タスク\n上記の「最終判断（結論）」に沿った理由付けとなるような、説得力のあるコメントの「本体部分」をそれぞれ生成してください。\n「中立」の場合は、なぜ判断が難しいのか、両方の側面に触れるようなコメントにしてください。\n結論と矛盾するコメントは絶対に生成しないでください。\n\n# 制約条件\n* あなたの回答は、有効なJSONオブジェクトのみを含むこと。\n* JSONオブジェクトの前後に、余計なテキストは一切含めないこと。\n* コメントはそれぞれ100文字以内で、ペルソナの個性を最大限に表現すること。\n* 出力は必ず以下のキーを持つJSONオブジェクトとすること: "bengo_comment", "houmu_comment", "onee_comment"`;
  let comments = await callApi(commentPrompt);
  if (comments.error) {
    comments = { bengo_comment: `（${comments.error}）`, houmu_comment: "（同上）", onee_comment: "（同上）" };
  }

  // --- 5. 合議結果と最終レスポンス ---
  let gougiScore = 0;
  Object.values(hanteiFlags).forEach(hantei => {
      if (hantei === "開示に賛成") gougiScore += 1;
      if (hantei === "中立") gougiScore += 0.5;
  });

  let gougiResult = "";
  let gougiClass = "";
  if (gougiScore >= 2) { gougiResult = "開示の可能性 大！"; gougiClass = "gougi-kettei"; }
  else if (gougiScore >= 1) { gougiResult = "開示の可能性あり (意見割れ)"; gougiClass = "gougi-ware"; }
  else { gougiResult = "見送り (開示は困難)"; gougiClass = "gougi-miokuri"; }
  if (bengoScore >= 7 && gougiScore < 2) { gougiResult = "弁護士暴走！開示請求すべき！"; gougiClass = "gougi-kettei"; }

  const getPrefix = (hantei, persona) => {
      if (hantei === "開示に賛成") return persona === "onee" ? "【判定：賛成よ！】" : "【判定：開示に賛成】";
      if (hantei === "中立") {
          if (persona === "bengo") return "【判定：中立（要検討）】";
          if (persona === "houmu") return "【判定：中立（要監視）】";
          if (persona === "onee") return "【判定：どっちとも言えないわね】";
      }
      return persona === "onee" ? "【判定：反対よ！】" : "【判定：開示に反対】";
  };

  const finalResponse = {
      gougi: gougiResult,
      gougiClass: gougiClass,
      bengo: getPrefix(hanteiFlags.bengo, "bengo") + " " + (comments.bengo_comment || ""),
      houmu: getPrefix(hanteiFlags.houmu, "houmu") + " " + (comments.houmu_comment || ""),
      onee: getPrefix(hanteiFlags.onee, "onee") + " " + (comments.onee_comment || ""),
      ai_reason: aiResult.reason 
  };
  
  res.status(200).json(finalResponse);
}