/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { GoogleGenAI, Type, GenerateContentResponse, GenerateImagesResponse, Modality } from "@google/genai";
import Chart from 'chart.js/auto';

// --- Interfaces ---
interface ArticleHistoryItem {
    id: number;
    theme: string;
    persona: string;
    expertPersona?: string;
    tone: string;
    articleType: 'free' | 'paid';
    markdown: string;
    html?: string; // Can be regenerated from markdown
    references: { uri: string; title: string; text?: string }[];
    enhancements: any;
    faqs?: { question: string, answer: string }[];
    coverImage?: string; // Cover image base64 data
    imageMap?: Record<string, string | { type: 'screenshot'; instruction: string }>;
    createdAt: string;
    scheduledAt?: string;
    performance?: ArticlePerformance;
    creativeDirection?: CreativeDirection;
    factCheck?: {
        status: 'unchecked' | 'checked';
        results: FactCheckResult[];
    };
    videoUrl?: string;
    videoStatus?: 'pending' | 'completed' | 'failed';
    videoOperationName?: string;
    lastCheckedForUpdate?: string;
    // New fields for monetization
    price?: number;
    productDescription?: string;
}
interface BrandVoice {
    principles: string;
    example: string;
}
interface ArticlePerformance {
    qualityScores: {
        readability: { score: number; feedback: string };
        engagement: { score: number; feedback: string };
        seo: { score: number; feedback: string };
    };
    personaResonance: {
        feedback: string;
    };
    engagementPrediction: {
        likes: string;
        shares: string;
        readTime: string;
    };
    abTestTitles: {
        title: string;
        predictedCTR: string;
    }[];
    userInput?: {
        views: string;
        engagementRate: string;
        conversions: string;
    };
}
interface CoPilotSuggestion {
    id: number;
    reason: string;
    original: string;
    suggested: string;
}
interface ArticleOutline {
    title: string;
    introduction: string;
    headings: string[];
}
interface CreativeDirection {
    style: string;
    palette: string[]; // hex codes
}
interface ImageGenerationTask {
    key: string;
    prompt: string;
    overlayText?: string;
}
interface FactCheckResult {
    statement: string;
    source: string;
    uri: string;
    result: 'match' | 'partial_match' | 'no_match';
    feedback: string;
}


// --- Global State ---
let articles: Omit<ArticleHistoryItem, 'coverImage' | 'imageMap'>[] = [];
let currentArticle: ArticleHistoryItem | null = null;
let activeMode: 'strategy' | 'create' | 'history' = 'create';
let brandVoice: BrandVoice = { principles: '', example: '' };
let utterance: SpeechSynthesisUtterance | null = null;
let isSpeaking = false;
let currentAudioContext: AudioContext | null = null;
let currentAudioSource: AudioBufferSourceNode | null = null;
let coPilotSuggestions: CoPilotSuggestion[] = [];
let suggestedOutlines: ArticleOutline[] = [];
let selectedOutline: ArticleOutline | null = null;
let suggestedDirections: CreativeDirection[] = [];
let selectedDirection: CreativeDirection | null = null;
let savedSelectionRange: Range | null = null;
let currentResearchedText: string = '';
let currentPerformanceArticleId: number | null = null;
let videoGenerationPollingInterval: number | null = null;
let currentAuditArticleId: number | null = null;
let currentAuditSuggestions: any[] = [];
let apiKey: string | null = null;


// --- IndexedDB Logic for Image Storage ---
const DB_NAME = 'ArticleArchitectDB';
const DB_VERSION = 1;
const STORE_NAME = 'articleImages';
let db: IDBDatabase;

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        if (db) {
            return resolve(db);
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = (event) => reject("IndexedDB error: " + (event.target as any).errorCode);
        request.onsuccess = (event) => {
            db = (event.target as any).result;
            resolve(db);
        };
        request.onupgradeneeded = (event) => {
            const db = (event.target as any).result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
    });
}

async function saveImagesToDb(id: number, coverImage?: string, imageMap?: ArticleHistoryItem['imageMap']): Promise<void> {
    try {
        const db = await openDb();
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        store.put({ id, coverImage, imageMap });
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    } catch (error) {
        console.error("Failed to save images to IndexedDB:", error);
    }
}

async function getImagesFromDb(id: number): Promise<{ coverImage?: string; imageMap?: ArticleHistoryItem['imageMap'] }> {
    try {
        const db = await openDb();
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(id);
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result || {});
            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.error("Failed to get images from IndexedDB:", error);
        return {};
    }
}

async function deleteImagesFromDb(id: number): Promise<void> {
    try {
        const db = await openDb();
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        store.delete(id);
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    } catch (error) {
        console.error("Failed to delete images from IndexedDB:", error);
    }
}


// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    // --- Element Selectors ---
    const modeStrategyBtn = document.getElementById('mode-strategy-btn') as HTMLButtonElement;
    const modeCreateBtn = document.getElementById('mode-create-btn') as HTMLButtonElement;
    const modeHistoryBtn = document.getElementById('mode-history-btn') as HTMLButtonElement;
    const settingsTitle = document.getElementById('settings-title') as HTMLHeadingElement;
    const strategyModeContent = document.getElementById('strategy-mode-content') as HTMLDivElement;
    const createModeContent = document.getElementById('create-mode-content') as HTMLDivElement;
    const historyModeContent = document.getElementById('history-mode-content') as HTMLDivElement;
    const historyList = document.getElementById('history-list') as HTMLUListElement;
    const strategyThemeInput = document.getElementById('strategy-theme') as HTMLInputElement;
    const strategyGenerateBtn = document.getElementById('strategy-generate-btn') as HTMLButtonElement;
    const strategyGenerateFromDataBtn = document.getElementById('strategy-generate-from-data-btn') as HTMLButtonElement;
    const strategySpinner = strategyGenerateBtn.querySelector('.spinner') as HTMLDivElement;
    const strategySpinnerFromData = strategyGenerateFromDataBtn.querySelector('.spinner') as HTMLDivElement;
    const strategyResultsContainer = document.getElementById('strategy-results-container') as HTMLDivElement;
    const strategyResultsTableBody = document.querySelector('#strategy-results-table tbody') as HTMLTableSectionElement;
    const form = document.getElementById('article-form') as HTMLFormElement;
    const analyzePersonaBtn = document.getElementById('analyze-persona-btn') as HTMLButtonElement;
    const spinner = (document.getElementById('generate-button') as HTMLButtonElement).querySelector('.spinner') as HTMLDivElement;
    const progressContainer = document.getElementById('progress') as HTMLDivElement;
    const generateVideoToggle = document.getElementById('generate-video-toggle') as HTMLInputElement;
    const fileUploadArea = document.getElementById('file-upload-area') as HTMLDivElement;
    const fileUploadInput = document.getElementById('file-upload-input') as HTMLInputElement;
    const fileInfoDiv = document.getElementById('file-info') as HTMLDivElement;
    const referenceTextArea = document.getElementById('reference-text') as HTMLTextAreaElement;
    const step1PersonaInput = document.getElementById('step-1-persona-input') as HTMLDivElement;
    const step2OutlineSuggestions = document.getElementById('step-2-outline-suggestions') as HTMLDivElement;
    const step3CreativeDirector = document.getElementById('step-3-creative-director') as HTMLDivElement;
    const outlineCardsContainer = document.getElementById('outline-cards-container') as HTMLDivElement;
    const creativeDirectionContainer = document.getElementById('creative-direction-container') as HTMLDivElement;
    const backToFormBtn = document.getElementById('back-to-form-btn') as HTMLButtonElement;
    const backToOutlinesBtn = document.getElementById('back-to-outlines-btn') as HTMLButtonElement;
    const resultContainer = document.getElementById('result') as HTMLDivElement;
    const initialMessage = document.getElementById('initial-message') as HTMLDivElement;
    const viewModeContainer = document.getElementById('view-mode-container') as HTMLDivElement;
    const editModeContainer = document.getElementById('edit-mode-container') as HTMLDivElement;
    const articleWrapper = document.getElementById('article-wrapper') as HTMLDivElement;
    const audioPlayerContainer = document.getElementById('audio-player-container') as HTMLDivElement;
    const coverImageContainer = document.getElementById('cover-image-container') as HTMLDivElement;
    const articleOutput = document.getElementById('article-output') as HTMLDivElement;
    const videoContainer = document.getElementById('video-container') as HTMLDivElement;
    const videoProgress = document.getElementById('video-progress') as HTMLDivElement;
    const videoPlayer = document.getElementById('video-player') as HTMLVideoElement;
    const videoDownloadLink = document.getElementById('video-download-link') as HTMLAnchorElement;
    const veoKeySelection = document.getElementById('veo-key-selection') as HTMLDivElement;
    const selectVeoKeyBtn = document.getElementById('select-veo-key-btn') as HTMLButtonElement;
    const faqContainer = document.getElementById('faq-container') as HTMLDivElement;
    const referencesContainer = document.getElementById('references-container') as HTMLDivElement;
    const referencesList = document.getElementById('references') as HTMLUListElement;
    const enhancementsContainer = document.getElementById('enhancements-container') as HTMLDivElement;
    const expansionContainer = document.getElementById('expansion-container') as HTMLDivElement;
    const expansionResultContainer = document.getElementById('expansion-result-container') as HTMLDivElement;
    const expansionOutput = document.getElementById('expansion-output') as HTMLTextAreaElement;
    const expansionButtons = document.querySelectorAll('.expansion-btn');
    const readAloudButton = document.getElementById('read-aloud-button') as HTMLButtonElement;
    const generateAudioButton = document.getElementById('generate-audio-btn') as HTMLButtonElement;
    const proofreadButton = document.getElementById('proofread-button') as HTMLButtonElement;
    const factCheckButton = document.getElementById('fact-check-button') as HTMLButtonElement;
    const scheduleButton = document.getElementById('schedule-button') as HTMLButtonElement;
    const editButton = document.getElementById('edit-button') as HTMLButtonElement;
    const copyButton = document.getElementById('copy-button') as HTMLButtonElement;
    const editTextArea = document.getElementById('edit-textarea') as HTMLTextAreaElement;
    const saveEditButton = document.getElementById('save-edit-button') as HTMLButtonElement;
    const cancelEditButton = document.getElementById('cancel-edit-button') as HTMLButtonElement;
    const contextMenu = document.getElementById('context-menu') as HTMLDivElement;
    const themeInput = document.getElementById('theme') as HTMLInputElement;
    const personaInput = document.getElementById('persona') as HTMLInputElement;
    const coPilotAnalyzeBtn = document.getElementById('co-pilot-analyze-btn') as HTMLButtonElement;
    const coPilotSuggestionsList = document.getElementById('co-pilot-suggestions-list') as HTMLUListElement;
    const brandVoiceBtn = document.getElementById('brand-voice-btn') as HTMLButtonElement;
    const brandVoiceModal = document.getElementById('brand-voice-modal') as HTMLDivElement;
    const closeBrandVoiceBtn = brandVoiceModal.querySelector('.modal-close-btn') as HTMLButtonElement;
    const saveBrandVoiceBtn = document.getElementById('save-brand-voice-btn') as HTMLButtonElement;
    const brandVoicePrinciplesInput = document.getElementById('brand-voice-principles') as HTMLTextAreaElement;
    const brandVoiceExampleInput = document.getElementById('brand-voice-example') as HTMLTextAreaElement;
    const performanceModal = document.getElementById('performance-modal') as HTMLDivElement;
    const closePerformanceModalBtn = document.getElementById('close-performance-modal-btn') as HTMLButtonElement;
    const savePerformanceBtn = document.getElementById('save-performance-btn') as HTMLButtonElement;
    const performanceViewsInput = document.getElementById('performance-views') as HTMLInputElement;
    const performanceEngagementRateInput = document.getElementById('performance-engagement-rate') as HTMLInputElement;
    const performanceConversionsInput = document.getElementById('performance-conversions') as HTMLInputElement;
    const researchModal = document.getElementById('research-modal') as HTMLDivElement;
    const closeResearchModalBtn = document.getElementById('close-research-modal-btn') as HTMLButtonElement;
    const researchSpinner = document.getElementById('research-spinner') as HTMLDivElement;
    const researchResults = document.getElementById('research-results') as HTMLDivElement;
    const researchOutput = document.getElementById('research-output') as HTMLTextAreaElement;
    const researchReferencesContainer = document.getElementById('research-references-container') as HTMLDivElement;
    const researchReferencesList = document.getElementById('research-references') as HTMLUListElement;
    const insertResearchBtn = document.getElementById('insert-research-btn') as HTMLButtonElement;
    const scheduleModal = document.getElementById('schedule-modal') as HTMLDivElement;
    const closeScheduleModalBtn = document.getElementById('close-schedule-modal-btn') as HTMLButtonElement;
    const scheduleDatetimeInput = document.getElementById('schedule-datetime') as HTMLInputElement;
    const saveScheduleBtn = document.getElementById('save-schedule-btn') as HTMLButtonElement;
    const removeScheduleBtn = document.getElementById('remove-schedule-btn') as HTMLButtonElement;
    const auditModal = document.getElementById('audit-modal') as HTMLDivElement;
    const closeAuditModalBtn = document.getElementById('close-audit-modal-btn') as HTMLButtonElement;
    const auditSpinner = document.getElementById('audit-spinner') as HTMLDivElement;
    const auditResults = document.getElementById('audit-results') as HTMLDivElement;
    const editWithSuggestionsBtn = document.getElementById('edit-with-suggestions-btn') as HTMLButtonElement;
    const apiKeyBtn = document.getElementById('api-key-btn') as HTMLButtonElement;
    const apiKeyModal = document.getElementById('api-key-modal') as HTMLDivElement;
    const closeApiKeyModalBtn = document.getElementById('close-api-key-modal-btn') as HTMLButtonElement;
    const saveApiKeyBtn = document.getElementById('save-api-key-btn') as HTMLButtonElement;
    const clearApiKeyBtn = document.getElementById('clear-api-key-btn') as HTMLButtonElement;
    const apiKeyInput = document.getElementById('api-key-input') as HTMLInputElement;
    const apiKeyStatus = document.getElementById('api-key-status') as HTMLDivElement;
    const productPreviewModal = document.getElementById('product-preview-modal') as HTMLDivElement;
    const closeProductPreviewModalBtn = document.getElementById('close-product-preview-modal-btn') as HTMLButtonElement;
    
    // --- Attach Event Listeners ---
    const readAloudTextSpan = readAloudButton.querySelector('.button-text') as HTMLSpanElement | null;
    
    modeStrategyBtn?.addEventListener('click', () => switchMode('strategy'));
    modeCreateBtn?.addEventListener('click', () => switchMode('create'));
    modeHistoryBtn?.addEventListener('click', () => switchMode('history'));

    strategyGenerateBtn?.addEventListener('click', () => generateStrategy(false));
    strategyGenerateFromDataBtn?.addEventListener('click', () => generateStrategy(true));
    form?.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (analyzePersonaBtn.disabled) return;
        currentResearchedText = ''; // Reset research text
        const formData = new FormData(form);
        const theme = formData.get('theme') as string;
        // Step 0a: Pre-research
        setLoading(true, 'AIがトピックをリサーチ中...');
        const researchPrompt = `あなたは専門リサーチャーです。以下のトピックについて、Google検索を用いて徹底的に調査し、信頼性の高い情報を基にした包括的なサマリーを作成してください。サマリーには、主要な事実、統計、専門家の見解、歴史的背景など、トピックを深く理解するために必要な要素を含めてください。出力はサマリーテキストのみとしてください。前置きや後書きは不要です。

# 調査トピック
${sanitizeString(theme)}`;
        try {
            const ai = getGenAIClient();
            const researchResponse = await withRetry<GenerateContentResponse>(() => ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: researchPrompt,
                config: { tools: [{ googleSearch: {} }] }
            }));
            currentResearchedText = researchResponse.text.trim();
            if (!currentResearchedText) {
                console.warn("AI research returned no content. Proceeding without it.");
            }
        } catch (error) {
            console.error("Error during pre-research step:", error);
            // Proceeding without research text on error
        }
        // Step 0b: Generate Outlines
        setLoading(true, 'リサーチを元に構成案を作成中...');
        const userInput = {
            theme: theme,
            persona: formData.get('persona') as string,
            referenceText: referenceTextArea.value,
        };
        let combinedReferenceText = userInput.referenceText;
        if (currentResearchedText) {
            const researchHeader = "\n\n# AIによる事前調査結果 (この記事の主要な情報源としてください)\n---\n";
            combinedReferenceText = userInput.referenceText
                ? `${userInput.referenceText}${researchHeader}${currentResearchedText}`
                : currentResearchedText;
        }
        let prompt = `あなたはバイラルメディアの編集長です。あなたの仕事は、読者の感情を激しく揺さぶり、SNSで爆発的にシェアされる記事の構成案を3つ作成することです。
提案は、それぞれ全く異なる、尖った切り口を持つ必要があります。

# 構成案作成の絶対原則
- **感情フック**: 各構成案は、人間の根源的な感情（驚き、怒り、共感、好奇心、優越感など）を刺激するものでなければなりません。
- **フレームワークの活用**: 構成には、人の心を動かす有名なコピーライティングのフレームワーク**「PASONAの法則」**を応用してください。
    - **P (Problem)**: 読者が心の奥底で抱えている「問題」をえぐり出す。
    - **A (Agitation)**: その問題を放置するとどうなるか、具体例を挙げて「煽り」、危機感を増幅させる。
    - **S (Solution)**: 読者が待ち望んでいた「解決策」として、記事の核心を提示する。
    - **O (Offer/Outcome)**: 解決策によって得られる理想の未来を具体的に示す。
    - **N (Narrow down)**: 読者を特定し、「これはあなたのための記事だ」と絞り込む。
    - **A (Action)**: 読者に具体的な「行動」を促す。
- **タイトル**: タイトルは記事の命です。常識を覆す**「逆説」**、強い言葉を使った**「断定」**、思わず続きが読みたくなる**「問いかけ」**を駆使し、クリックせずにはいられないタイトルを付けてください。
- **導入文**: 読者が最初の2行で引き込まれるように、衝撃的な事実、共感を呼ぶ失敗談、あるいは読者の固定観念を壊す問いから始めてください。

# 出力形式
各提案には、そのユニークな「切り口」がわかるようなキャッチーなタイトル、読者を物語に引き込む導入文、そして上記のフレームワークに基づいた論理的な見出し構成（3〜5個）を含めてください。`;

        if (combinedReferenceText) {
            prompt += `

# 重要: 参照資料
以下のテキストの内容を**最優先の情報源**として構成案を作成してください。
---
${safeSubstring(sanitizeString(combinedReferenceText), 8000)}
---`;
        }
        prompt += `

# テーマ
${sanitizeString(userInput.theme)}

# ターゲット読者（ペルソナ）
${sanitizeString(userInput.persona)}
`;
        const schema = {
            type: Type.OBJECT,
            properties: {
                outlines: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            title: { type: Type.STRING, description: "キャッチーなタイトル" },
                            introduction: { type: Type.STRING, description: "読者の心を掴む導入文" },
                            headings: { type: Type.ARRAY, items: { type: Type.STRING }, description: "論理的な見出しのリスト" }
                        },
                        required: ["title", "introduction", "headings"]
                    }
                }
            },
            required: ["outlines"]
        };
        try {
            const ai = getGenAIClient();
            const response = await withRetry<GenerateContentResponse>(() => ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt, config: { responseMimeType: 'application/json', responseSchema: schema } }));
            const result = JSON.parse(response.text);
            suggestedOutlines = result.outlines;
            renderOutlineSuggestions();
            step1PersonaInput.classList.add('hidden');
            step2OutlineSuggestions.classList.remove('hidden');
        } catch (error) {
            console.error("Error analyzing persona:", error);
            alert("構成案の生成中にエラーが発生しました。APIキーが正しいか確認してください。");
        } finally {
            setLoading(false);
        }
    });
    backToFormBtn?.addEventListener('click', () => {
        step1PersonaInput.classList.remove('hidden');
        step2OutlineSuggestions.classList.add('hidden');
        step3CreativeDirector.classList.add('hidden');
        suggestedOutlines = [];
        selectedOutline = null;
        currentResearchedText = '';
    });
    backToOutlinesBtn?.addEventListener('click', () => {
        step2OutlineSuggestions.classList.remove('hidden');
        step3CreativeDirector.classList.add('hidden');
        suggestedDirections = [];
        selectedDirection = null;
    });
    saveEditButton?.addEventListener('click', async () => {
        if (!currentArticle) return;
        const newMarkdown = editTextArea.value;
        saveEditButton.textContent = '保存中...';
        saveEditButton.disabled = true;
// FIX: The function analyzeArticlePerformance was not defined. Added the function definition.
        const newPerformance = await analyzeArticlePerformance(newMarkdown, currentArticle.theme, currentArticle.persona);
        if (newPerformance && currentArticle.performance?.userInput) {
            newPerformance.userInput = currentArticle.performance.userInput;
        }
        const updatedArticle: ArticleHistoryItem = { ...currentArticle, markdown: newMarkdown, html: '', performance: newPerformance, factCheck: { status: 'unchecked', results: [] } };
        await updateArticleInHistory(updatedArticle);
        renderArticle(updatedArticle);
        viewModeContainer.classList.remove('hidden');
        editModeContainer.classList.add('hidden');
        saveEditButton.textContent = '変更を保存';
        saveEditButton.disabled = false;
    });
    brandVoiceBtn?.addEventListener('click', () => brandVoiceModal.classList.remove('hidden'));
    closeBrandVoiceBtn?.addEventListener('click', () => brandVoiceModal.classList.add('hidden'));
    saveBrandVoiceBtn?.addEventListener('click', () => { saveBrandVoiceToStorage(); brandVoiceModal.classList.add('hidden'); });
    brandVoiceModal?.addEventListener('click', (e) => { if (e.target === brandVoiceModal) { brandVoiceModal.classList.add('hidden'); } });
    factCheckButton?.addEventListener('click', async () => {
        if (!currentArticle || factCheckButton.disabled) return;
        const spinner = factCheckButton.querySelector('.spinner') as HTMLDivElement;
        const buttonText = factCheckButton.querySelector('.button-text') as HTMLSpanElement;
        const originalText = buttonText.textContent;
        factCheckButton.disabled = true;
        spinner.classList.remove('hidden');
        buttonText.textContent = '検証中...';
        const factCheckWrapper = document.getElementById('fact-check-wrapper') as HTMLDivElement;
        factCheckWrapper.innerHTML = '<div class="step-spinner"></div> AIが検証中です...';
        document.getElementById('fact-check-container')?.classList.remove('hidden');
        const cleanMarkdownForFactCheck = currentArticle.markdown
            .replace(/\[(IMAGE_GENERATE|IMAGE_SCREENSHOT|INTERACTIVE_CHART):({[\s\S]*?})\]/g, '')
            .replace(/---ここから有料---/g, '');
        const prompt = `あなたは精密なファクトチェッカーです。以下の記事本文から、検証可能な事実（例：数値、統計、固有名詞を含む断定的な記述）を抽出し、その正しさをGoogle検索を用いて検証してください。

# 指示
1.  記事の中から検証すべき記述を**最大5つまで**抽出してください。
2.  抽出した各記述について、Google検索で**日本の信頼性の高い情報源**（公的機関、主要メディア、学術論文など）を探してください。
3.  情報源と記述を比較し、結果を以下のいずれかで評価してください。
    - \`match\`: 信頼できる情報源と内容が一致する。
    - \`partial_match\`: 類似の情報は見つかるが、数値や文脈が微妙に異なる。
    - \`no_match\`: 信頼できる情報源が見つからない、または情報が誤っている可能性が高い。
4.  結果をJSON形式で出力してください。出力はJSONオブジェクトのみとし、前後に説明文や\`\`\`jsonのようなマークダウンは含めないでください。スキーマは以下の通りです:
    {
        "factCheckResults": [
            {
                "statement": "検証対象の記述",
                "source": "情報源のタイトル",
                "uri": "情報源のURL",
                "result": "match, partial_match, or no_match",
                "feedback": "検証結果に関する簡単な解説"
            }
        ]
    }

# 記事本文
---
${safeSubstring(sanitizeString(cleanMarkdownForFactCheck), 5000)}
---
`;
        try {
            const ai = getGenAIClient();
            const response = await withRetry<GenerateContentResponse>(() => ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
                config: {
                    tools: [{ googleSearch: {} }],
                }
            }));
            let jsonText = response.text.trim();
            if (jsonText.startsWith('```json')) {
                jsonText = jsonText.substring(7);
                if (jsonText.endsWith('```')) {
                    jsonText = jsonText.substring(0, jsonText.length - 3);
                }
            }
            const result = JSON.parse(jsonText);
            const factCheckResults = result.factCheckResults as FactCheckResult[];
            if (currentArticle) {
                currentArticle.factCheck = {
                    status: 'checked',
                    results: factCheckResults
                };
                await updateArticleInHistory(currentArticle);
            }
            displayFactCheckResults(factCheckResults);
        } catch (error) {
            console.error("Error during fact-checking:", error);
            factCheckWrapper.innerHTML = `<p class="error">ファクトチェック中にエラーが発生しました。</p>`;
        } finally {
            factCheckButton.disabled = false;
            spinner.classList.add('hidden');
            buttonText.textContent = originalText;
        }
    });
    coPilotAnalyzeBtn?.addEventListener('click', async () => {
        if (!currentArticle || coPilotAnalyzeBtn.disabled) return;
        const markdown = editTextArea.value;
        const buttonText = coPilotAnalyzeBtn.querySelector('.button-text') as HTMLSpanElement;
        const spinner = coPilotAnalyzeBtn.querySelector('.spinner') as HTMLDivElement;
        coPilotAnalyzeBtn.disabled = true;
        spinner.classList.remove('hidden');
        buttonText.textContent = '分析中...';
        coPilotSuggestionsList.innerHTML = '<div class="step-spinner"></div> AIが分析中です...';
        const coPilotPrompt = `あなたはプロのコンテンツ編集者であり、AIコパイロットです。以下の記事本文を分析し、改善点を提案してください。
提案は、記事のメタデータ（テーマ、ペルソナ、トーン）に基づいて行ってください。

# 記事メタデータ
- テーマ・キーワード: ${sanitizeString(currentArticle.theme)}
- ターゲット読者（ペルソナ）: ${sanitizeString(currentArticle.persona)}
- 記事のトーン: ${sanitizeString(currentArticle.tone)}

# 分析の観点
- **読みやすさ**: 長すぎる文章、複雑な表現、専門用語の乱用などを指摘してください。
- **エンゲージメント**: 読者の興味を引くための問いかけ、共感を呼ぶ表現、具体例の追加などを提案してください。
- **トーンの一貫性**: 指定された「${currentArticle.tone}」なトーンから逸脱している部分を修正してください。
- **SEO**: テーマ「${currentArticle.theme}」に関連するキーワードを自然に追加する提案をしてください。

# 出力形式
提案のリストをJSON形式で返してください。各提案には、以下のキーを含めてください。
- \`reason\`: なぜこの変更を推奨するのかという具体的な理由。
- \`original\`: 変更対象となる、記事本文から抜き出した**正確な**一部分。
- \`suggested\`: 改善後の文章。

# 記事本文
---
${sanitizeString(markdown)}
---
`;
        const schema = { type: Type.OBJECT, properties: { suggestions: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { reason: { type: Type.STRING }, original: { type: Type.STRING }, suggested: { type: Type.STRING } }, required: ['reason', 'original', 'suggested'] } } }, required: ['suggestions'] };
        try {
            const ai = getGenAIClient();
            const response = await withRetry<GenerateContentResponse>(() => ai.models.generateContent({ model: 'gemini-2.5-flash', contents: coPilotPrompt, config: { responseMimeType: 'application/json', responseSchema: schema } }));
            const result = JSON.parse(response.text);
            coPilotSuggestions = result.suggestions.map((s: any, index: number) => ({ ...s, id: index }));
            renderCoPilotSuggestions();
        } catch (error) {
            console.error("Error analyzing with Co-pilot:", error);
            coPilotSuggestionsList.innerHTML = `<li class="error">分析中にエラーが発生しました。</li>`;
        } finally {
            coPilotAnalyzeBtn.disabled = false;
            spinner.classList.add('hidden');
            buttonText.textContent = 'ドキュメントを再分析';
        }
    });
    articleOutput?.addEventListener('mouseup', (e) => {
        const selection = window.getSelection();
        if (selection && selection.toString().trim().length > 10) {
            savedSelectionRange = selection.getRangeAt(0).cloneRange();
            showContextMenu(e.clientX, e.clientY);
        } else {
            contextMenu.classList.add('hidden');
        }
    });
    document.addEventListener('click', () => contextMenu.classList.add('hidden'));
    closeResearchModalBtn?.addEventListener('click', () => researchModal.classList.add('hidden'));
    researchModal?.addEventListener('click', (e) => { if (e.target === researchModal) { researchModal.classList.add('hidden'); } });
    insertResearchBtn?.addEventListener('click', () => {
        if (savedSelectionRange) {
            savedSelectionRange.deleteContents();
            savedSelectionRange.insertNode(document.createTextNode(researchOutput.value));
        }
        researchModal.classList.add('hidden');
    });
    scheduleButton?.addEventListener('click', () => {
        if (!currentArticle) return;
        if (currentArticle.scheduledAt) {
            const d = new Date(currentArticle.scheduledAt);
            const formatted = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            scheduleDatetimeInput.value = formatted;
            removeScheduleBtn.classList.remove('hidden');
            saveScheduleBtn.textContent = '予約を更新';
        } else {
            scheduleDatetimeInput.value = '';
            removeScheduleBtn.classList.add('hidden');
            saveScheduleBtn.textContent = '予約を設定';
        }
        scheduleModal.classList.remove('hidden');
    });
    closeScheduleModalBtn?.addEventListener('click', () => scheduleModal.classList.add('hidden'));
    scheduleModal?.addEventListener('click', (e) => { if (e.target === scheduleModal) { scheduleModal.classList.add('hidden'); } });
    saveScheduleBtn?.addEventListener('click', async () => {
        if (!currentArticle) return;
        const scheduleDate = scheduleDatetimeInput.value;
        if (scheduleDate) {
            currentArticle.scheduledAt = new Date(scheduleDate).toISOString();
            await updateArticleInHistory(currentArticle);
            scheduleModal.classList.add('hidden');
        } else {
            alert('有効な日時を選択してください。');
        }
    });
    removeScheduleBtn?.addEventListener('click', async () => {
        if (!currentArticle) return;
        currentArticle.scheduledAt = undefined;
        await updateArticleInHistory(currentArticle);
        scheduleModal.classList.add('hidden');
    });
    proofreadButton?.addEventListener('click', async () => {
        if (!currentArticle || proofreadButton.disabled) return;
        const spinner = proofreadButton.querySelector('.spinner') as HTMLDivElement;
        const buttonText = proofreadButton.querySelector('.button-text') as HTMLSpanElement;
        const originalText = buttonText.textContent;
        proofreadButton.disabled = true;
        spinner.classList.remove('hidden');
        buttonText.textContent = '校正中...';
        const prompt = `あなたはプロの日本人編集者です。以下のMarkdown形式の記事を徹底的に校正・推敲してください。
目的は、誤字脱字、文法的な誤り、不自然な言い回しを全て修正し、ネイティブの読者が読んでも一切の違和感がない、完璧に洗練された日本語の文章に磨き上げることです。
元のMarkdown構造（見出し、リスト、リンクなど）は絶対に破壊しないでください。記事の内容や意図を勝手に変更しないでください。
修正後の記事本文（Markdown）のみを返してください。余計な挨拶や説明は不要です。
# 校正対象の記事
---
${safeSubstring(sanitizeString(currentArticle.markdown), 15000)}
---
`;
        try {
            const ai = getGenAIClient();
            const response = await withRetry<GenerateContentResponse>(() => ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt }));
            const proofreadMarkdown = response.text;
            if (!proofreadMarkdown.trim()) {
                throw new Error("AIからの応答が空でした。");
            }
            const updatedArticle = { ...currentArticle, markdown: proofreadMarkdown, html: '' };
            await updateArticleInHistory(updatedArticle);
            renderArticle(updatedArticle);
        } catch (error) {
            console.error("Error during proofreading:", error);
            alert('AIによる校正中にエラーが発生しました。');
        } finally {
            proofreadButton.disabled = false;
            spinner.classList.add('hidden');
            buttonText.textContent = originalText;
        }
    });
    copyButton?.addEventListener('click', () => { if (!currentArticle) return; navigator.clipboard.writeText(currentArticle.markdown).then(() => { const buttonText = copyButton.querySelector('.button-text'); if (buttonText) buttonText.textContent = 'コピーしました！'; setTimeout(() => { if (buttonText) buttonText.textContent = 'コピー'; }, 2000); }); });
    document.querySelectorAll('.copy-small-button').forEach(button => {
        button.addEventListener('click', () => {
            const el = button as HTMLElement;
            const targetId = el.dataset.target;
            if (targetId) {
                const textarea = document.getElementById(targetId) as HTMLTextAreaElement;
                navigator.clipboard.writeText(textarea.value);
            }
        });
    });
    editButton?.addEventListener('click', () => { if (!currentArticle) return; stopSpeech(); stopGeneratedAudio(); viewModeContainer.classList.add('hidden'); editModeContainer.classList.remove('hidden'); editTextArea.value = currentArticle.markdown; coPilotSuggestions = []; coPilotSuggestionsList.innerHTML = ''; (coPilotAnalyzeBtn.querySelector('.button-text') as HTMLSpanElement).textContent = 'ドキュメントを分析'; editTextArea.focus(); });
    cancelEditButton?.addEventListener('click', () => { viewModeContainer.classList.remove('hidden'); editModeContainer.classList.add('hidden'); });
    readAloudButton?.addEventListener('click', toggleSpeech);
    generateAudioButton?.addEventListener('click', async () => {
        if (!currentArticle || generateAudioButton.disabled) return;
        stopGeneratedAudio();
        const spinner = generateAudioButton.querySelector('.spinner') as HTMLDivElement;
        const buttonText = generateAudioButton.querySelector('.button-text') as HTMLSpanElement;
        const originalText = buttonText.textContent;
        generateAudioButton.disabled = true;
        spinner.classList.remove('hidden');
        buttonText.textContent = '生成中...';
        try {
            const textToSpeak = currentArticle.markdown
                .replace(/\[(IMAGE_GENERATE|IMAGE_SCREENSHOT|INTERACTIVE_CHART|BOX|SUMMARY):([\s\S]*?)\]/g, '')
                .replace(/#/g, '')
                .replace(/\[.*?\]\(.*?\)/g, (match, p1) => p1) // Keep link text
                .replace(/<\/?[^>]+(>|$)/g, ""); // Remove HTML tags
            const ai = getGenAIClient();
            const response = await withRetry<GenerateContentResponse>(() => ai.models.generateContent({
                model: "gemini-2.5-flash-preview-tts",
                contents: [{ parts: [{ text: `以下の文章を、プロのナレーターのように、自然で聞き取りやすいトーンで読み上げてください。「${textToSpeak}` }] }],
                config: {
                    responseModalities: [Modality.AUDIO],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: { voiceName: 'Kore' },
                        },
                    },
                },
            }));
            const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
            if (!base64Audio) {
                throw new Error("AIから音声データが返されませんでした。");
            }
            currentAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
            const audioBuffer = await decodeAudioData(decode(base64Audio), currentAudioContext, 24000, 1);
            const audioBlob = bufferToWave(audioBuffer, audioBuffer.length);
            const audioUrl = URL.createObjectURL(audioBlob);
            const audio = new Audio(audioUrl);
            audio.controls = true;
            audioPlayerContainer.innerHTML = '';
            audioPlayerContainer.appendChild(audio);
            audioPlayerContainer.classList.remove('hidden');
            audio.play();
        } catch (error) {
            console.error("Error generating audio article:", error);
            audioPlayerContainer.innerHTML = `<p class="error">音声の生成に失敗しました。</p>`;
            audioPlayerContainer.classList.remove('hidden');
        } finally {
            generateAudioButton.disabled = false;
            spinner.classList.add('hidden');
            buttonText.textContent = originalText;
        }
    });
    closePerformanceModalBtn?.addEventListener('click', () => performanceModal.classList.add('hidden'));
    performanceModal?.addEventListener('click', (e) => { if (e.target === performanceModal) { performanceModal.classList.add('hidden'); } });
    savePerformanceBtn?.addEventListener('click', async () => {
        if (!currentPerformanceArticleId) return;
        const articleIndex = articles.findIndex(h => h.id === currentPerformanceArticleId);
        if (articleIndex === -1) return;
        const article = articles[articleIndex];
        // To update performance, we need the full article object, but we only have the stub.
        // Let's just update the stub and save. This part of the logic assumes performance exists.
        // A more robust solution might fetch the full article first.
        const fullArticle = { ...article, ...(await getImagesFromDb(article.id)) };
        if (!fullArticle.performance) {
            fullArticle.performance = {} as ArticlePerformance;
        }
        fullArticle.performance.userInput = {
            views: performanceViewsInput.value,
            engagementRate: performanceEngagementRateInput.value,
            conversions: performanceConversionsInput.value,
        };
        await updateArticleInHistory(fullArticle);
        if (currentArticle && currentArticle.id === fullArticle.id) {
            renderArticle(fullArticle);
        }
        performanceModal.classList.add('hidden');
        currentPerformanceArticleId = null;
    });
    selectVeoKeyBtn?.addEventListener('click', async () => {
        await (window as any).aistudio.openSelectKey();
        if (currentArticle) {
            generateVideo(currentArticle);
        }
    });
    expansionButtons.forEach(button => {
        button.addEventListener('click', () => {
            if (!currentArticle) return;
            const format = (button as HTMLElement).dataset.format as 'twitter' | 'youtube' | 'presentation';
            repurposeContent(currentArticle, format, button as HTMLButtonElement);
        });
    });

    fileUploadArea?.addEventListener('dragover', (e) => {
        e.preventDefault();
        fileUploadArea.classList.add('drag-over');
    });

    fileUploadArea?.addEventListener('dragleave', () => {
        fileUploadArea.classList.remove('drag-over');
    });

    fileUploadArea?.addEventListener('drop', (e) => {
        e.preventDefault();
        fileUploadArea.classList.remove('drag-over');
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
            handleFile(files[0]);
        }
    });

    fileUploadInput?.addEventListener('change', () => {
        if (fileUploadInput.files && fileUploadInput.files.length > 0) {
            handleFile(fileUploadInput.files[0]);
        }
    });
    
    closeAuditModalBtn?.addEventListener('click', () => auditModal.classList.add('hidden'));
    auditModal?.addEventListener('click', (e) => { if (e.target === auditModal) { auditModal.classList.add('hidden'); } });

    editWithSuggestionsBtn?.addEventListener('click', async () => {
        if (!currentAuditArticleId) return;
        const articleStub = articles.find(a => a.id === currentAuditArticleId);
        if (!articleStub) return;

        const imageData = await getImagesFromDb(articleStub.id);
        const article = { ...articleStub, ...imageData };
        
        // Load article for editing
        renderArticle(article);
        switchMode('create'); // Make sure we are in the right mode
        
        // Open the editor
        stopSpeech();
        stopGeneratedAudio();
        viewModeContainer.classList.add('hidden');
        editModeContainer.classList.remove('hidden');
        editTextArea.value = article.markdown;
        
        // Populate Co-pilot panel with suggestions
        if (currentAuditSuggestions.length > 0) {
            coPilotSuggestions = []; // Clear previous suggestions
            const suggestionsHtml = `
                <li class="co-pilot-suggestion-item audit-suggestion-block">
                    <strong>AI監査による更新提案:</strong>
                    <ul style="padding-left: 1.2rem; margin-top: 0.5rem;">
                        ${currentAuditSuggestions.map(s => `
                            <li style="margin-bottom: 0.75rem;">
                                <strong>${s.area}:</strong> ${s.suggestion_text} 
                                <em style="color: #666; display: block; font-size: 0.8rem;">(${s.reason})</em>
                            </li>
                        `).join('')}
                    </ul>
                </li>
            `;
            coPilotSuggestionsList.innerHTML = suggestionsHtml;
        } else {
             coPilotSuggestionsList.innerHTML = '';
        }
        (coPilotAnalyzeBtn.querySelector('.button-text') as HTMLSpanElement).textContent = 'ドキュメントを再分析';
        editTextArea.focus();
        
        // Close modal
        auditModal.classList.add('hidden');
    });
    
    // --- New API Key Modal Listeners ---
    apiKeyBtn?.addEventListener('click', () => {
        apiKeyInput.value = getApiKey() || '';
        apiKeyStatus.style.display = 'none';
        apiKeyModal.classList.remove('hidden');
    });
    closeApiKeyModalBtn?.addEventListener('click', () => apiKeyModal.classList.add('hidden'));
    apiKeyModal?.addEventListener('click', (e) => { if (e.target === apiKeyModal) { apiKeyModal.classList.add('hidden'); } });
    saveApiKeyBtn?.addEventListener('click', async () => {
        const key = apiKeyInput.value.trim();
        if (!key) {
            setApiKeyStatus('APIキーを入力してください。', 'error');
            return;
        }
        
        saveApiKeyBtn.disabled = true;
        saveApiKeyBtn.textContent = '検証中...';

        try {
            const ai = new GoogleGenAI({ apiKey: key });
            await ai.models.generateContent({model: 'gemini-2.5-flash', contents: 'Hi'}); // Simple validation call
            saveApiKey(key);
            setApiKeyStatus('APIキーが正常に保存されました。', 'success');
            checkApiKeyOnLoad(); // Re-check to enable form if it was disabled
            setTimeout(() => {
                apiKeyModal.classList.add('hidden');
            }, 1000);
        } catch (error) {
            console.error("API Key validation failed", error);
            setApiKeyStatus('APIキーが無効です。もう一度確認してください。', 'error');
        } finally {
             saveApiKeyBtn.disabled = false;
             saveApiKeyBtn.textContent = 'キーを保存して検証';
        }
    });
    clearApiKeyBtn?.addEventListener('click', () => {
        clearApiKey();
        apiKeyInput.value = '';
        setApiKeyStatus('APIキーを削除しました。', 'success');
        checkApiKeyOnLoad();
    });

    closeProductPreviewModalBtn?.addEventListener('click', () => productPreviewModal.classList.add('hidden'));
    productPreviewModal?.addEventListener('click', (e) => { if(e.target === productPreviewModal) productPreviewModal.classList.add('hidden') });

    // --- Initial State Setup ---
    checkApiKeyOnLoad();
    loadBrandVoiceFromStorage();
    loadArticlesFromStorage();
    renderHistoryList();
    switchMode('create');
});


const progressSteps = [
    "✍️ 記事本文を執筆中...",
    "🎨 記事を装飾＆ビジュアル計画中...",
    "🖼️ 画像コンテンツを生成中...",
    "💡 Q&Aセクションを作成中...",
    "🚀 パフォーマンスを分析＆予測中...",
    "✨ 投稿アシスト情報を生成中...",
    "✅ 記事が完成しました！",
];

// --- Mode Switching Logic ---
function switchMode(mode: 'strategy' | 'create' | 'history') {
    stopSpeech();
    stopGeneratedAudio();
    activeMode = mode;

    const strategyModeContent = document.getElementById('strategy-mode-content') as HTMLDivElement;
    const createModeContent = document.getElementById('create-mode-content') as HTMLDivElement;
    const historyModeContent = document.getElementById('history-mode-content') as HTMLDivElement;
    const modeStrategyBtn = document.getElementById('mode-strategy-btn') as HTMLButtonElement;
    const modeCreateBtn = document.getElementById('mode-create-btn') as HTMLButtonElement;
    const modeHistoryBtn = document.getElementById('mode-history-btn') as HTMLButtonElement;
    const settingsTitle = document.getElementById('settings-title') as HTMLHeadingElement;
    const step1PersonaInput = document.getElementById('step-1-persona-input') as HTMLDivElement;
    const step2OutlineSuggestions = document.getElementById('step-2-outline-suggestions') as HTMLDivElement;
    const step3CreativeDirector = document.getElementById('step-3-creative-director') as HTMLDivElement;


    const modes = { strategy: strategyModeContent, create: createModeContent, history: historyModeContent };
    const buttons = { strategy: modeStrategyBtn, create: modeCreateBtn, history: modeHistoryBtn };
    const titles = { strategy: 'コンテンツ戦略を立案', create: '記事の設計図を作成', history: '商品管理' };

    for (const [key, element] of Object.entries(modes)) {
        element.classList.toggle('hidden', key !== mode);
    }
    for (const [key, button] of Object.entries(buttons)) {
        button.classList.toggle('active', key !== mode);
    }
    settingsTitle.textContent = titles[mode];
    if (mode === 'create') {
        step1PersonaInput.classList.remove('hidden');
        step2OutlineSuggestions.classList.add('hidden');
        step3CreativeDirector.classList.add('hidden');
    }
}

function selectStrategy(keyword: string, persona: string) {
    (document.getElementById('theme') as HTMLInputElement).value = keyword;
    (document.getElementById('persona') as HTMLInputElement).value = persona;
    switchMode('create');
}

/**
 * Parses user-inputted performance strings (e.g., "1,500", "10k") into numbers.
 * @param val The string value to parse.
 * @returns The parsed number, or 0 if invalid.
 */
const robustParseInt = (val: string | undefined): number => {
    if (!val) return 0;
    const cleaned = String(val).toLowerCase().replace(/,/g, '').trim();
    if (cleaned.endsWith('k')) {
        return Math.floor(parseFloat(cleaned) * 1000);
    }
    if (cleaned.endsWith('m')) {
        return Math.floor(parseFloat(cleaned) * 1000000);
    }
    const num = parseInt(cleaned, 10);
    return isNaN(num) ? 0 : num;
};


// --- Strategy Mode Logic ---
async function generateStrategy(fromData = false) {
    const strategyThemeInput = document.getElementById('strategy-theme') as HTMLInputElement;
    const strategyGenerateBtn = document.getElementById('strategy-generate-btn') as HTMLButtonElement;
    const strategyGenerateFromDataBtn = document.getElementById('strategy-generate-from-data-btn') as HTMLButtonElement;
    const strategyResultsContainer = document.getElementById('strategy-results-container') as HTMLDivElement;
    const strategyResultsTableBody = document.querySelector('#strategy-results-table tbody') as HTMLTableSectionElement;

    const theme = strategyThemeInput.value;
    if (!theme && !fromData) return;
    if (strategyGenerateBtn.disabled || strategyGenerateFromDataBtn.disabled) return;
    
    setStrategyLoading(true, fromData);
    strategyResultsContainer.classList.add('hidden');
    strategyResultsTableBody.innerHTML = '';

    let strategyPrompt = `あなたは世界クラスのSEOコンサルタント兼マーケティングストラテジストです。`;
    
    if(fromData) {
        const successfulArticles = articles.filter(h => h.performance?.userInput && (robustParseInt(h.performance.userInput.views) > 1000 || robustParseInt(h.performance.userInput.conversions) > 10));
        if (successfulArticles.length === 0) {
            strategyResultsTableBody.innerHTML = `<tr><td colspan="3" class="error">分析可能な成功データが不足しています。履歴から記事のパフォーマンスを入力してください。</td></tr>`;
            setStrategyLoading(false, fromData);
            strategyResultsContainer.classList.remove('hidden'); // Show the container to display the error
            return;
        }
        
        const successStories = successfulArticles.slice(0, 5).map(article => `
- テーマ: ${article.theme}
- ペルソナ: ${article.persona}
- タイトル: ${article.enhancements?.titleSuggestions?.[0] || article.theme}
- パフォーマンス: 閲覧数 ${article.performance?.userInput?.views}, エンゲージメント率 ${article.performance?.userInput?.engagementRate}, CV数 ${article.performance?.userInput?.conversions}
`).join('\n');

        strategyPrompt += `
以下の過去の成功事例を徹底的に分析し、成功の共通要因を特定してください。
その分析に基づき、ユーザーが次に取り組むべき、最も成果が期待できる新しいコンテンツ戦略を5つ提案してください。

# 過去の成功事例
---
${successStories}
---
`;

    } else {
         strategyPrompt += `ユーザーが入力したテーマに基づいて、効果的なコンテンツ戦略を立案してください。`;
    }

    strategyPrompt += `
以下の要件に従い、JSON形式で戦略案を5つ提案してください。
出力形式のスキーマ: { "strategies": [ { "keyword": "提案するSEOキーワード", "intent": "そのキーワードで検索するユーザーの検索意図", "persona": "そのキーワードで検索する典型的なユーザー像" } ] }
`;
    if(!fromData) {
        strategyPrompt += `ユーザーが入力したテーマ: --- ${sanitizeString(theme)} ---`;
    }

    const strategySchema = { type: Type.OBJECT, properties: { strategies: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { keyword: { type: Type.STRING }, intent: { type: Type.STRING }, persona: { type: Type.STRING } }, required: ['keyword', 'intent', 'persona'] } } }, required: ['strategies'] };
    try {
        const ai = getGenAIClient();
        const response = await withRetry<GenerateContentResponse>(() => ai.models.generateContent({ model: 'gemini-2.5-flash', contents: strategyPrompt, config: { responseMimeType: 'application/json', responseSchema: strategySchema } }));
        const result = JSON.parse(response.text);
        displayStrategyResults(result.strategies);
    } catch (error) {
        console.error("Error generating strategy:", error);
        strategyResultsTableBody.innerHTML = `<tr><td colspan="3" class="error">戦略の生成中にエラーが発生しました。</td></tr>`;
    } finally {
        setStrategyLoading(false, fromData);
    }
}

function displayStrategyResults(strategies: { keyword: string, intent: string, persona: string }[]) {
    const strategyResultsTableBody = document.querySelector('#strategy-results-table tbody') as HTMLTableSectionElement;
    const strategyResultsContainer = document.getElementById('strategy-results-container') as HTMLDivElement;
    strategyResultsTableBody.innerHTML = '';
    strategies.forEach(strategy => {
        const row = document.createElement('tr');
        row.innerHTML = `<td>${strategy.keyword}</td><td>${strategy.intent}</td><td>${strategy.persona}</td>`;
        row.addEventListener('click', () => selectStrategy(strategy.keyword, strategy.persona));
        strategyResultsTableBody.appendChild(row);
    });
    strategyResultsContainer.classList.remove('hidden');
}
function setStrategyLoading(isLoading: boolean, fromData: boolean) {
    const strategyGenerateBtn = document.getElementById('strategy-generate-btn') as HTMLButtonElement;
    const strategyGenerateFromDataBtn = document.getElementById('strategy-generate-from-data-btn') as HTMLButtonElement;
    const strategySpinner = strategyGenerateBtn.querySelector('.spinner') as HTMLDivElement;
    const strategySpinnerFromData = strategyGenerateFromDataBtn.querySelector('.spinner') as HTMLDivElement;
    if(fromData) {
        strategyGenerateFromDataBtn.disabled = isLoading;
        strategySpinnerFromData.classList.toggle('hidden', !isLoading);
    } else {
        strategyGenerateBtn.disabled = isLoading;
        strategySpinner.classList.toggle('hidden', !isLoading);
        (strategyGenerateBtn.querySelector('.button-text') as HTMLSpanElement).textContent = isLoading ? '分析中...' : 'AIに戦略を提案させる';
    }
}

// --- Article Generation Logic (NEW ASSEMBLY LINE APPROACH) ---

// Step 0: Outline Suggestions

function renderOutlineSuggestions() {
    const outlineCardsContainer = document.getElementById('outline-cards-container') as HTMLDivElement;
    outlineCardsContainer.innerHTML = '';
    suggestedOutlines.forEach((outline, index) => {
        const card = document.createElement('div');
        card.className = 'outline-card';
        card.dataset.index = index.toString();
        card.innerHTML = `
            <div class="outline-card-title">${outline.title}</div>
            <p class="outline-card-intro">${outline.introduction}</p>
            <ul class="outline-card-headings">
                ${outline.headings.map(h => `<li>${h}</li>`).join('')}
            </ul>
        `;
        card.addEventListener('click', () => {
            selectedOutline = suggestedOutlines[index];
            document.querySelectorAll('.outline-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            generateCreativeDirections();
        });
        outlineCardsContainer.appendChild(card);
    });
}

// Step 1: Creative Directions
async function generateCreativeDirections() {
    setLoading(true, 'デザイン案を作成中...');
    (document.getElementById('step-2-outline-suggestions') as HTMLDivElement).classList.add('hidden');
    
    const form = document.getElementById('article-form') as HTMLFormElement;
    const formData = new FormData(form);
    const theme = formData.get('theme') as string;
    const persona = formData.get('persona') as string;

    const prompt = `あなたはプロのアートディレクターです。以下のテーマとペルソナに最適な、記事のデザインディレクションを3つ提案してください。各提案は、読者の心に響く独自のスタイルとカラーパレットを持つ必要があります。
# テーマ
${sanitizeString(theme)}
# 読者ペルソナ
${sanitizeString(persona)}
`;

    const schema = {
        type: Type.OBJECT,
        properties: {
            directions: {
                type: Type.ARRAY,
                items: {
                    type: Type.OBJECT,
                    properties: {
                        style: { type: Type.STRING, description: "デザインスタイルの名称（例：ミニマル、ポップ、信頼性）" },
                        palette: { type: Type.ARRAY, items: { type: Type.STRING }, description: "スタイルを表現する3色のHEXカラーコードの配列。1色目はメインカラー、2色目はテキストカラー、3色目はアクセントカラー。" }
                    },
                    required: ["style", "palette"]
                }
            }
        },
        required: ["directions"]
    };

    try {
        const ai = getGenAIClient();
        const response = await withRetry<GenerateContentResponse>(() => ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt, config: { responseMimeType: 'application/json', responseSchema: schema } }));
        const result = JSON.parse(response.text);
        suggestedDirections = result.directions;
        renderCreativeDirections();
        (document.getElementById('step-3-creative-director') as HTMLDivElement).classList.remove('hidden');
    } catch(e) {
        console.error("Error generating creative directions:", e);
        // Fallback to direct article generation
        generateArticleAssemblyLine();
    } finally {
        setLoading(false);
    }
}

function renderCreativeDirections() {
    const creativeDirectionContainer = document.getElementById('creative-direction-container') as HTMLDivElement;
    creativeDirectionContainer.innerHTML = '';
    suggestedDirections.forEach((direction, index) => {
        const card = document.createElement('div');
        card.className = 'creative-direction-card';
        card.dataset.index = index.toString();
        card.innerHTML = `
            <div class="style-title">${direction.style}</div>
            <div class="palette-container">
                ${direction.palette.map(color => `<div class="palette-color" style="background-color: ${color}"></div>`).join('')}
            </div>
        `;
        card.addEventListener('click', () => {
            selectedDirection = suggestedDirections[index];
            document.querySelectorAll('.creative-direction-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            setTimeout(() => {
                generateArticleAssemblyLine();
            }, 300);
        });
        creativeDirectionContainer.appendChild(card);
    });
}


// --- NEW ASSEMBLY LINE ---
async function generateArticleAssemblyLine() {
    if (!selectedOutline) return;

    (document.getElementById('step-2-outline-suggestions') as HTMLDivElement).classList.add('hidden');
    (document.getElementById('step-3-creative-director') as HTMLDivElement).classList.add('hidden');
    setLoading(true);
    resetUI();

    const form = document.getElementById('article-form') as HTMLFormElement;
    const formData = new FormData(form);
    const referenceTextArea = document.getElementById('reference-text') as HTMLTextAreaElement;
    const originalReferenceText = referenceTextArea.value;
    
    let combinedReferenceText = originalReferenceText;
    if (currentResearchedText) {
        const researchHeader = "\n\n# AIによる事前調査結果 (この記事の主要な情報源としてください)\n---\n";
        combinedReferenceText = originalReferenceText
            ? `${originalReferenceText}${researchHeader}${currentResearchedText}`
            : currentResearchedText;
    }

    const userInput = {
        theme: formData.get('theme') as string,
        persona: formData.get('persona') as string,
        expertPersona: formData.get('expert-persona') as string,
        tone: formData.get('tone') as string,
        articleType: formData.get('article_type') as 'free' | 'paid',
        referenceText: combinedReferenceText, // Use the combined text
        price: Number(formData.get('price')) || undefined,
        productDescription: formData.get('product-description') as string || undefined,
    };
    
    const generateVideoToggle = document.getElementById('generate-video-toggle') as HTMLInputElement;
    const shouldGenerateVideo = generateVideoToggle.checked;
    let newArticleItem: ArticleHistoryItem | null = null;
    const articleOutput = document.getElementById('article-output') as HTMLDivElement;
    const resultContainer = document.getElementById('result') as HTMLDivElement;


    try {
        // Step 1: Generate Core Article Text
        updateProgress(0);
        const { markdown: coreMarkdown, references: coreReferences } = await step1_generateCoreText(userInput, selectedOutline);
        articleOutput.innerText = coreMarkdown; // Show raw text progress

        // Step 2: Decorate Markdown with Visuals
        updateProgress(1);
        const { decoratedMarkdown, coverImagePrompt, coverImageOverlay } = await step2_decorateMarkdown(coreMarkdown);

        // Step 3: Parse and Generate Images
        updateProgress(2);
        const imageGenerateRegex = /\[IMAGE_GENERATE:({.*?})\]/g;
        const articleImageTasks: ImageGenerationTask[] = [];
        let match;
        while ((match = imageGenerateRegex.exec(decoratedMarkdown)) !== null) {
            try {
                const placeholder = match[0]; // The full placeholder string
                const jsonData = JSON.parse(match[1]);
                articleImageTasks.push({
                    key: placeholder, // Use the full placeholder as the key
                    prompt: jsonData.prompt,
                    overlayText: jsonData.overlayText
                });
            } catch (e) {
                console.error("Failed to parse IMAGE_GENERATE JSON", e);
            }
        }
        
        const allImageTasks = [
            { key: 'cover', prompt: coverImagePrompt, overlayText: coverImageOverlay },
            ...articleImageTasks
        ];
// FIX: The function generateAndStoreImages was not defined. Added the function definition.
        const generatedImages = await generateAndStoreImages(allImageTasks);
        
        // Step 4, 5, 6 happen inside finalizeArticle
        newArticleItem = await finalizeArticle(decoratedMarkdown, coreReferences, generatedImages, userInput);
        
        if (shouldGenerateVideo && newArticleItem) {
             // Don't await this, let it run in the background
             generateVideo(newArticleItem);
        }


    } catch (e: any) {
        console.error("Article assembly line failed:", e);
        resultContainer.classList.remove('hidden'); // Ensure result area is visible for error message
        articleOutput.innerHTML = `<p class="error">記事の生成中にエラーが発生しました: ${e.message}</p>`;
        setLoading(false);
    }
}

async function step1_generateCoreText(userInput: any, outline: ArticleOutline): Promise<{ markdown: string, references: any[] }> {
    const currentYear = new Date().getFullYear();
    let systemInstruction = ``;
    
    if(userInput.expertPersona) {
        systemInstruction = `あなたは「${sanitizeString(userInput.expertPersona)}」です。その人物になりきり、専門知識、経験、そしてその職業特有の口調や視点を持って、以下の記事を執筆してください。`
    } else {
        systemInstruction = `あなたはプロのライターです。あなたの唯一の仕事は、提供された構成案と要件に基づき、読者の心に響く高品質な記事本文をMarkdown形式で執筆することです。`
    }


    if (userInput.referenceText) {
        systemInstruction += `\n# 執筆の最重要ルール\n- **最優先事項**: 提供された「参照資料」のテキストを記事の主要な情報源としてください。その内容を元に、構成案に沿って文章を肉付けしてください。\n- **情報源の補完**: 「参照資料」だけでは情報が不足する場合、またはより新しい情報が必要な場合に限り、Google検索の結果を補足的に使用してください。`;
    } else {
        systemInstruction += `\n# 厳守事項\n- **情報源**: 記事内容はGoogle検索の結果のみをソースとします。これは必須です。`;
    }

    systemInstruction += `
- **鮮度**: 常に最新の情報をGoogle検索で取得し、執筆時点での最も新しい事実に基づいてください。今日は${currentYear}年です。

- **執筆スタイル - 「AIっぽさ」の完全払拭**:
    1. **人間味のある言葉遣い**: 堅苦しい専門用語や定型文を避け、まるで人間がすぐ隣で語りかけているかのような、自然で滑らかな口語体で執筆してください。
    2. **多様な表現**: 単調な文章の繰り返しは厳禁です。多様な語彙を使い、単文・複文・重文をリズミカルに組み合わせ、読者を飽きさせない文章を作成してください。
    3. **五感に訴える描写**: 読者が情景をありありとイメージできるよう、比喩（メタファー）、直喩（シミリ）、擬人法、そして具体的なエピソードをふんだんに盛り込んでください。
    4. **読者との対話**: 「〜だと思いませんか？」「もしあなたが〇〇なら、どうしますか？」のように、読者に積極的に問いかけ、対話するようなスタイルで親近感を演出してください。

- **引用と情報源に関する絶対厳守のルール**:
    1.  **唯一の情報源**: あなたが記事内で使用するすべての外部リンク（本文中の引用リンク、セクション末尾の参考URL）は、**必ず**システムから提供されるGoogle検索の\`groundingChunks\`（参照メタデータ）に含まれる\`uri\`と\`title\`を使用しなければなりません。
    2.  **創作の禁止**: \`groundingChunks\`に存在しないURLや情報を**絶対に創作しないでください**。これは最も重要なルールです。
    3.  **直接引用**: 記述内容と最も関連性の高い\`groundingChunks\`の情報を選択し、その\`uri\`と\`title\`を**そのまま**使用してください。URLを改変したり、無関係なページを引用したりすることは固く禁じられています。
    4.  **リンク形式**: リンクは \`[groundingChunksから取得したtitle](groundingChunksから取得したuri)\` というMarkdown形式を**厳守**してください。\`[出典]\` や \`[こちら]\` のような曖昧なテキストは**絶対に使用しないでください。**
    5.  **検証不要**: あなたはURLに実際にアクセスする必要はありません。\`groundingChunks\`として提供された情報が、検証済みの信頼できる情報源であると仮定してください。
    6.  **一貫性**: 本文中の引用と、セクション末尾に記載する「参考URL」は、同じ\`groundingChunks\`の情報を参照するようにしてください。
    7.  **セクション末尾の出典明記**: 各見出し（セクション）の本文が終わった後、次の見出しの前に、改行して \`参考URL：[そのセクションで引用した参照元のページタイトル](有効なURL)\` の形式で、そのセクションで用いた主要な出典を再度明記してください。
    8.  **正しい引用の例**:
        (本文中) \`日本のスマートフォン普及率は96.3%に達しました。[令和4年通信利用動向調査の結果 - 総務省](https://www.soumu.go.jp/johotsusintokei/statistics/data/230529_1.pdf)\`
        (セクションの末尾) \`参考URL：[令和4年通信利用動向調査の結果 - 総務省](https://www.soumu.go.jp/johotsusintokei/statistics/data/230529_1.pdf)\`
    9.  **絶対禁止の例**: \`普及率は96.3%です。[出典](https://example.com/non-existent-page)\`

- **出力**: 応答はMarkdown形式のテキストのみとし、挨拶や前置き、後書きは一切含めないでください。`;

    if (userInput.articleType === 'paid') {
        systemInstruction += `\n- **有料記事の執筆戦略**:
            - **無料部分の役割**: 無料部分では、読者が抱える問題の深刻さをえぐり出し、解決への強い渇望を喚起させることが目的です。解決策の「さわり」だけを見せ、期待感を最大限に高めてください。
            - **価値のティーザー**: 有料部分でしか手に入らない「秘匿性の高いノウハウ」「具体的な手順を示したテンプレート」「時間と労力を大幅に削減する裏技」などの価値を、無料部分で繰り返し示唆してください。
            - **有料への橋渡し**: \`---ここから有料---\` の区切り線の直前には、読者が「ここからが本題だ！」と感じ、購入せずにはいられなくなるような、最も核心的で魅力的なクリフハンガーを配置してください。
            - **有料部分の約束**: 有料部分では、読者の期待を上回る圧倒的な価値を提供してください。具体的、実践的、そしてすぐに使える情報で構成し、読者に「この金額を払って本当に良かった」と心から思わせる内容にしてください。`;
    }
    if (brandVoice.principles || brandVoice.example) {
        systemInstruction += `\n\n**ブランドボイス:**\n`;
        if (brandVoice.principles) systemInstruction += `- 執筆原則: ${sanitizeString(brandVoice.principles)}\n`;
        if (brandVoice.example) systemInstruction += `- 文体サンプル:\n---\n${safeSubstring(sanitizeString(brandVoice.example), 4000)}\n---`;
    }

    let userPrompt = `以下の承認された構成案と要件に基づいて、最高の記事を執筆してください。`;

    if (userInput.referenceText) {
        userPrompt += `\n\n---参照資料 (最優先の情報源)---\n${safeSubstring(sanitizeString(userInput.referenceText), 12000)}\n--------------------`;
    }
    
    userPrompt += `
*   **テーマ**: ${safeSubstring(sanitizeString(userInput.theme), 200)}
*   **ペルソナ**: ${safeSubstring(sanitizeString(userInput.persona), 500)}
*   **トーン**: ${sanitizeString(userInput.tone)}
*   **記事の種類**: ${userInput.articleType === 'paid' ? '有料記事' : '無料記事'}

---承認された構成案---
# ${safeSubstring(sanitizeString(outline.title), 200)}
**導入文**:
${safeSubstring(sanitizeString(outline.introduction), 1000)}
**見出し構成**:
${outline.headings.map(h => `- ${sanitizeString(h)}`).join('\n')}
--------------------
**最終指示**: 上記の「引用と情報源に関する絶対厳守のルール」を絶対に守って、高品質な記事を執筆してください。`;

    const ai = getGenAIClient();
    let fullText = '';
    let groundingMetadata: any[] = [];
    const responseStream = await withRetry<AsyncGenerator<GenerateContentResponse>>(() => ai.models.generateContentStream({
        model: 'gemini-2.5-pro', // Using a more powerful model for better writing with references
        contents: userPrompt,
        config: {
            systemInstruction: systemInstruction,
            tools: [{ googleSearch: {} }],
        },
    }));

    for await (const chunk of responseStream) {
        if (chunk.text) fullText += chunk.text;
        if (chunk.candidates?.[0]?.groundingMetadata?.groundingChunks) {
            groundingMetadata.push(...chunk.candidates[0].groundingMetadata.groundingChunks);
        }
    }

    if (!fullText.trim()) {
        throw new Error("AIが記事本文の生成に失敗しました（ステップ1）。応答が空でした。");
    }

    // Post-processing to remove hallucinated links
    const validUris = new Set(
        groundingMetadata
            .filter(chunk => chunk.web && chunk.web.uri)
            .map(chunk => chunk.web.uri)
    );

    const processedMarkdown = fullText.trim().replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g, (match, text, url) => {
        if (validUris.has(url)) {
            return match; // Keep the valid link
        } else {
            console.warn(`Removing hallucinated link: ${url}`);
            return text; // Remove the invalid link, keep the text
        }
    });


    return { markdown: processedMarkdown, references: groundingMetadata };
}

async function step2_decorateMarkdown(markdownText: string): Promise<{ decoratedMarkdown: string; coverImagePrompt: string; coverImageOverlay: string; }> {
    const prompt = `あなたは優秀なアートディレクター兼エディターです。以下の記事本文（Markdown）を分析し、より魅力的で視覚的に豊かなコンテンツに編集してください。

# 指示
あなたの仕事は、受け取ったMarkdownテキストを直接編集し、以下の要素を追加することです。
1.  **絵文字の追加**: 全ての「##」と「###」で始まる見出しの末尾に、内容に合った絵文字を1つ追加してください。
2.  **記事内画像の挿入**: 記事の理解を深めるのに最も効果的だと思われる箇所に、画像生成用のプレースホルダー \`[IMAGE_GENERATE:{"prompt":"ここに詳細な英語の画像生成プロンプト", "overlayText":"ここに日本語のオーバーレイテキスト"}]\` を**ちょうど2つ**挿入してください。
    - **重要**: プロンプトを作成する際は、日本の読者が親しみを感じるような人物、風景、文化を考慮してください。例えば、人物は日本人やアジア人を登場させ、背景も日本の街並みやオフィスを想定してください。プロンプトは非常に具体的で、高品質な画像が生成されるようにしてください。
3.  **クリエイティブなグラフの挿入**: 記事内の数値データ、比較、構成比率などを視覚的に表現するために、最も効果的な箇所にグラフのプレースホルダーを**最大2つまで**挿入してください。
    - **チャートの選択**: 単なる棒グラフだけでなく、**円グラフ(pie)、ドーナツチャート(doughnut)、レーダーチャート(radar)、散布図(scatter)、バブルチャート(bubble)**など、文脈に最も適した**クリエイティブで視覚的に魅力的な**チャートタイプを選択してください。読者が一目で情報を理解できるような、洞察に富んだグラフをデザインしてください。グラフが不要な場合は挿入しないでください。
    - **形式**: \`[INTERACTIVE_CHART:{"type":"bar", "title":"グラフのタイトル", "data":{"labels":["項目1", "項目2"],"datasets":[{"label":"データセット名", "data":[10, 20]}]}}]\`
    - **JSONフォーマットの絶対厳守**:
        - プレースホルダー内のJSONは、寸分違わず正しい構文でなければなりません。
        - **最重要: 配列内のカンマ**: \`labels\`配列や\`data\`配列の各要素の間には、**絶対にカンマ(,)を省略しないでください。**
            - **正しい例**: \`"labels": ["項目1", "項目2", "項目3"]\`
            - **絶対にダメな例 (間違い)**: \`"labels": ["項目1" "項目2" "項目3"]\` (カンマが欠落している)
        - **プロパティ名**: \`type\`, \`title\`, \`data\`, \`labels\`, \`datasets\`, \`label\` といったキー名は必ずダブルクォート(\`"\`)で囲んでください。
        - **文字列**: 全ての文字列（タイトル、ラベルなど）は必ずダブルクォート(\`"\`)で囲んでください。
    - **正しい形式の例**: \`[INTERACTIVE_CHART:{"type":"bar","title":"日本のSNS利用率(%)","data":{"labels":["X (Twitter)","Instagram","Facebook"],"datasets":[{"label":"利用率","data":[66.5,50.1,32.6]}]}}]\`
    - **最終チェック**: JSONを生成した後、それが有効なJSONであるか、特に配列のカンマが正しいか、必ず自己検証してください。
4.  **スクリーンショットの挿入**: UI操作の説明やWebサイトの紹介など、画面キャプチャが有効な箇所があれば、その指示をプレースホルダー \`[IMAGE_SCREENSHOT:{"instruction":"ここに日本語での撮影指示"}]\` として**積極的に**挿入してください。必要なければ挿入しないでください。
5.  **情報ボックスと要約の追加**:
    - 読者の注意を引くべき補足情報やヒントがある箇所に、\`[BOX:tip|info|warning|quote:タイトル:本文]\` 形式でボックスを挿入してください。
    - 記事の要点をまとめるのに最適な場所に、\`[SUMMARY:箇条書き1; 箇条書き2; 箇条書き3]\` 形式でサマリーボックスを挿入してください。
6.  **重要ルール**: \`参考URL：[...](...)\` という形式の行は、編集せずにそのまま保持してください。これらの行は記事の構造の一部であり、削除や変更はしないでください。

# 出力形式
最終的な成果物を、以下のJSONスキーマに厳密に従って返してください。
- \`decoratedMarkdown\`: 上記の指示に従って編集された、**完全な**Markdownテキスト。
- \`coverImagePrompt\`: 記事全体を象徴する、魅力的で詳細な**英語の**画像生成プロンプト。ここでも日本の読者を意識してください。
- \`coverImageOverlay\`: カバー画像に重ねるキャッチーな**日本語の**オーバーレイテキスト。

# 編集対象の記事本文
---
${safeSubstring(sanitizeString(markdownText), 8000)}
---`;

    const schema = {
        type: Type.OBJECT,
        properties: {
            decoratedMarkdown: { type: Type.STRING, description: "絵文字とプレースホルダーが挿入された完全なMarkdownテキスト" },
            coverImagePrompt: { type: Type.STRING, description: "カバー画像の英語プロンプト" },
            coverImageOverlay: { type: Type.STRING, description: "カバー画像の日本語オーバーレイテキスト" }
        },
        required: ['decoratedMarkdown', 'coverImagePrompt', 'coverImageOverlay']
    };

    try {
        const ai = getGenAIClient();
        const response = await withRetry<GenerateContentResponse>(() => ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt, config: { responseMimeType: 'application/json', responseSchema: schema } }));
        const result = JSON.parse(response.text);
        if (!result.decoratedMarkdown || !result.coverImagePrompt || !result.coverImageOverlay) {
            throw new Error("AIが不完全なJSONを返しました。");
        }
        return result;
    } catch (e: any) {
        console.error("Failed to decorate markdown or parse JSON:", e);
        throw new Error(`AIによる記事の装飾に失敗しました: ${e.message}`);
    }
}

// --- AI Generation Sub-components ---
async function generateAndStoreImages(tasks: ImageGenerationTask[]): Promise<Record<string, string | "error">> {
    const results: Record<string, string | "error"> = {};
    const ai = getGenAIClient();

    for (const task of tasks) {
        try {
            // Using Imagen for higher quality with overlays
            const fullPrompt = task.overlayText ? `${task.prompt}, with the text "${task.overlayText}" clearly visible` : task.prompt;
            
            const response = await withRetry<GenerateImagesResponse>(() => ai.models.generateImages({
                model: 'imagen-4.0-generate-001',
                prompt: fullPrompt,
                config: {
                    numberOfImages: 1,
                    outputMimeType: 'image/jpeg',
                    aspectRatio: '16:9', // good for cover images
                },
            }));

            if (response.generatedImages && response.generatedImages.length > 0) {
                const base64ImageBytes = response.generatedImages[0].image.imageBytes;
                results[task.key] = base64ImageBytes;
            } else {
                throw new Error("No images were generated by the API.");
            }
        } catch (error) {
            console.error(`Failed to generate image for prompt "${task.prompt}":`, error);
            results[task.key] = "error";
        }
    }
    return results;
}

async function generateFaqSection(markdown: string): Promise<{ question: string, answer: string }[] | undefined> {
    const prompt = `あなたは読者の疑問を予測する専門家です。以下の記事を読み、読者が抱くであろう最も重要な質問を3つ予測し、それに対する簡潔で分かりやすい回答を作成してください。

# 記事本文
---
${safeSubstring(sanitizeString(markdown), 8000)}
---

# 出力形式
JSON形式で、質問と回答のペアの配列を返してください。
`;
    const schema = {
        type: Type.OBJECT,
        properties: {
            faqs: {
                type: Type.ARRAY,
                items: {
                    type: Type.OBJECT,
                    properties: {
                        question: { type: Type.STRING, description: "予測される質問" },
                        answer: { type: Type.STRING, description: "質問に対する回答" }
                    },
                    required: ["question", "answer"]
                }
            }
        },
        required: ["faqs"]
    };
    try {
        const ai = getGenAIClient();
        const response = await withRetry<GenerateContentResponse>(() => ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: { responseMimeType: 'application/json', responseSchema: schema }
        }));
        const result = JSON.parse(response.text);
        return result.faqs;
    } catch (error) {
        console.error("Error generating FAQ section:", error);
        return undefined;
    }
}

async function analyzeArticlePerformance(markdown: string, theme: string, persona: string): Promise<ArticlePerformance | undefined> {
    const prompt = `あなたはプロのコンテンツアナリストです。以下の記事本文を分析し、パフォーマンスを予測・評価してください。

# 分析対象記事
---
${safeSubstring(sanitizeString(markdown), 8000)}
---

# 記事のメタデータ
- テーマ: ${sanitizeString(theme)}
- ターゲット読者（ペルソナ）: ${sanitizeString(persona)}

# 分析と評価の指示
以下の項目について、JSON形式で詳細な分析結果を返してください。
1.  **品質スコア**:
    - \`readability\`: 読みやすさ (0-100点) と具体的な改善フィードバック。
    - \`engagement\`: 読者のエンゲージメントを引き出す力 (0-100点) と具体的な改善フィードバック。
    - \`seo\`: SEOの強さ (0-100点) と具体的な改善フィードバック。
2.  **ペルソナ共鳴度**:
    - \`personaResonance\`: 指定されたペルソナにどれだけ響くか、具体的なフィードバック。
3.  **エンゲージメント予測**:
    - \`engagementPrediction\`: この記事がSNSでシェアされた場合の予測エンゲージメント（例: "100-200" のように範囲で示す）。"likes"（いいね数）、"shares"（シェア数）、"readTime"（平均読了時間、例: "約3分"）。
4.  **A/Bテスト用タイトル案**:
    - \`abTestTitles\`: クリック率を高めるための、異なる切り口のタイトル案を3つ提案。それぞれの予測CTR（例: "3-5%"）も添えること。

# 出力形式
JSONオブジェクトのみを返してください。前後に説明やマークダウンは不要です。
`;
    const schema = {
        type: Type.OBJECT,
        properties: {
            qualityScores: {
                type: Type.OBJECT,
                properties: {
                    readability: { type: Type.OBJECT, properties: { score: { type: Type.NUMBER }, feedback: { type: Type.STRING } }, required: ['score', 'feedback'] },
                    engagement: { type: Type.OBJECT, properties: { score: { type: Type.NUMBER }, feedback: { type: Type.STRING } }, required: ['score', 'feedback'] },
                    seo: { type: Type.OBJECT, properties: { score: { type: Type.NUMBER }, feedback: { type: Type.STRING } }, required: ['score', 'feedback'] }
                },
                required: ['readability', 'engagement', 'seo']
            },
            personaResonance: { type: Type.OBJECT, properties: { feedback: { type: Type.STRING } }, required: ['feedback'] },
            engagementPrediction: { type: Type.OBJECT, properties: { likes: { type: Type.STRING }, shares: { type: Type.STRING }, readTime: { type: Type.STRING } }, required: ['likes', 'shares', 'readTime'] },
            abTestTitles: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { title: { type: Type.STRING }, predictedCTR: { type: Type.STRING } }, required: ['title', 'predictedCTR'] } }
        },
        required: ['qualityScores', 'personaResonance', 'engagementPrediction', 'abTestTitles']
    };

    try {
        const ai = getGenAIClient();
        const response = await withRetry<GenerateContentResponse>(() => ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: { responseMimeType: 'application/json', responseSchema: schema }
        }));
        const result = JSON.parse(response.text);
        return result as ArticlePerformance;
    } catch (error) {
        console.error("Error analyzing article performance:", error);
        return undefined;
    }
}

async function generateEnhancements(markdown: string): Promise<any> {
    const prompt = `あなたはSNSマーケティングとSEOの専門家です。以下の記事本文を元に、拡散と検索流入を最大化するための補足コンテンツを生成してください。

# 記事本文
---
${safeSubstring(sanitizeString(markdown), 8000)}
---

# 生成するコンテンツ
1.  **titleSuggestions**: 読者の興味を惹きつけ、クリックしたくなるようなキャッチーなタイトル案を3つ。
2.  **snsShareText**: X (Twitter) でシェアするための、エンゲージメントが高まるような紹介文（140字以内）。
3.  **hashtags**: 関連性が高く、トレンドも意識したハッシュタグを5つ（#は不要）。
4.  **metaDescription**: 検索結果に表示されることを想定した、記事の要約（120字以内）。

# 出力形式
JSONオブジェクトのみを返してください。
`;

    const schema = {
        type: Type.OBJECT,
        properties: {
            titleSuggestions: { type: Type.ARRAY, items: { type: Type.STRING } },
            snsShareText: { type: Type.STRING },
            hashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
            metaDescription: { type: Type.STRING }
        },
        required: ['titleSuggestions', 'snsShareText', 'hashtags', 'metaDescription']
    };

    try {
        const ai = getGenAIClient();
        const response = await withRetry<GenerateContentResponse>(() => ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: { responseMimeType: 'application/json', responseSchema: schema }
        }));
        return JSON.parse(response.text);
    } catch (error) {
        console.error("Error generating enhancements:", error);
        return { titleSuggestions: [], snsShareText: '', hashtags: [], metaDescription: '' };
    }
}


async function finalizeArticle(finalMarkdown: string, coreReferences: any[], generatedImages: Record<string, string | "error">, userInput: any): Promise<ArticleHistoryItem> {
    // Create the final imageMap from the generated images and by parsing the markdown again for screenshots
    const finalImageMap: ArticleHistoryItem['imageMap'] = { ...generatedImages };
    
    const screenshotRegex = /\[IMAGE_SCREENSHOT:({.*?})\]/g;
    let match;
    while ((match = screenshotRegex.exec(finalMarkdown)) !== null) {
        try {
            const placeholder = match[0];
            const jsonData = JSON.parse(match[1]);
            finalImageMap[placeholder] = { type: 'screenshot', instruction: jsonData.instruction };
        } catch (e) {
            console.error("Failed to parse IMAGE_SCREENSHOT JSON", e);
        }
    }
    
    // Clean the markdown for analysis models to improve reliability
    const cleanMarkdownForAnalysis = finalMarkdown
        .replace(/\[(IMAGE_GENERATE|IMAGE_SCREENSHOT|INTERACTIVE_CHART):({[\s\S]*?})\]/g, '')
        .replace(/---ここから有料---/g, '');

// FIX: The function generateFaqSection was not defined. Added the function definition.
    updateProgress(3); // FAQ Generation
    const faqs = await generateFaqSection(cleanMarkdownForAnalysis);

// FIX: The function analyzeArticlePerformance was not defined. Added the function definition.
    updateProgress(4); // Performance Analysis
    const performance = await analyzeArticlePerformance(cleanMarkdownForAnalysis, userInput.theme, userInput.persona);
    
// FIX: The function generateEnhancements was not defined. Added the function definition.
    updateProgress(5); // Enhancements
    const enhancements = await generateEnhancements(cleanMarkdownForAnalysis);
    
    updateProgress(6); // Complete
    
    const groundedReferences = coreReferences
        .filter(chunk => chunk.web && chunk.web.uri)
        .map(chunk => ({ uri: chunk.web.uri, title: chunk.web.title || chunk.web.uri, }));

    const uniqueReferences = [...new Map(groundedReferences.map(item => [item.uri, item])).values()];
    const finalReferences = uniqueReferences.slice(0, 7); // Limit references to a maximum of 7

    const coverImageData = generatedImages['cover'] !== 'error' ? generatedImages['cover'] as string : undefined;

    const newItem: ArticleHistoryItem = {
        id: Date.now(),
        theme: userInput.theme,
        persona: userInput.persona,
        expertPersona: userInput.expertPersona,
        tone: userInput.tone,
        articleType: userInput.articleType,
        markdown: finalMarkdown,
        html: '', // Will be generated in renderArticle
        references: finalReferences,
        enhancements,
        faqs,
        coverImage: coverImageData,
        imageMap: finalImageMap,
        performance,
        creativeDirection: selectedDirection ?? undefined,
        factCheck: { status: 'unchecked', results: [] },
        createdAt: new Date().toLocaleString('ja-JP'),
        price: userInput.price,
        productDescription: userInput.productDescription,
    };
    await addArticleToHistory(newItem);
    renderArticle(newItem);
    setLoading(false);
    return newItem;
}

// --- Rendering and Display Logic ---
function renderMarkdownToHtml(markdown: string): string {
    let html = markdown
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    html = html.replace(/\[INTERACTIVE_CHART:([\s\S]*?)\]/gs, (match, jsonString) => {
        try {
            // Validate that the string is valid JSON before proceeding.
            JSON.parse(jsonString);
            // HTML-encode double quotes for the attribute value, as the attribute itself is wrapped in double quotes.
            const encodedJsonString = jsonString.replace(/"/g, '&quot;');
            return `<div class="chart-container"><canvas data-chart-data="${encodedJsonString}"></canvas></div>`;
        } catch (e) {
            console.error("Failed to parse chart JSON from Markdown:", e, "JSON string:", jsonString);
            return '<div class="error">グラフデータの解析に失敗しました。AIが生成したデータが不正な形式です。</div>';
        }
    });
    
    html = html.replace(/\[(IMAGE_GENERATE|IMAGE_SCREENSHOT):({[\s\S]*?})\]/g, (match) => {
        return `<div class="image-placeholder-wrapper" data-key="${encodeUnicode(match)}"></div>`;
    });

    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    html = html.replace(/---ここから有料---/g, '<hr class="paid-divider" data-text="ここから有料">');
    html = html.replace(/\[BOX:(tip|info|warning|quote):([\s\S]*?)\]/gs, (match, type, content) => {
        const parts = content.split(':');
        const title = parts.shift() || '';
        const body = parts.join(':');
        const iconSvg = {
            tip: '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M10 20c.55 0 1-.45 1-1v-2.34c1.64-.16 3.1-.93 4.21-2.04.18-.18.18-.46 0-.63l-1.06-1.06c-.18-.18-.46-.18-.63 0l-.35.35c-1.1-1.1-2.65-1.81-4.32-1.93V8c0-.55-.45-1-1-1s-1 .45-1 1v2.34c-1.64.16-3.1.93-4.21-2.04-.18.18.18-.46 0 .63l1.06 1.06c.18.18.46.18.63 0l.35-.35c1.1 1.1 2.65 1.81 4.32 1.93V19c0 .55.45 1 1 1zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>',
            info: '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>',
            warning: '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',
            quote: '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M6 17h3l2-4V7H5v6h3zm8 0h3l2-4V7h-6v6h3z"/></svg>',
        };
        const icon = iconSvg[type] || iconSvg.info;
        return `<div class="info-box info-box-${type}">
                    <div class="info-box-header">${icon} ${title}</div>
                    <div class="info-box-body">${body}</div>
                </div>`;
    });
    html = html.replace(/\[SUMMARY:([\s\S]*?)\]/gs, (match, content) => {
        const items = content.split(';').map(item => `<li>${item.trim()}</li>`).join('');
        return `<div class="summary-box">
                    <div class="summary-box-header"><svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M12 17.27l4.15 2.51-1.08-4.72 3.67-3.18-4.83-.41L12 7.18l-1.98 4.3-4.83.41 3.67 3.18-1.08 4.72L12 17.27z"/></svg> Key Takeaways</div>
                    <ul class="summary-box-list">${items}</ul>
                </div>`;
    });
    html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    
    // Process lists
    html = html.replace(/^( *)(-|\*|\d+\.) (.*$)/gim, (match, indent, marker, content) => {
        const isOrdered = /^\d/.test(marker);
        const tag = isOrdered ? 'ol' : 'ul';
        return `${indent}<${tag}><li>${content}</li></${tag}>`;
    });
     // Consolidate adjacent lists
    html = html.replace(/<\/(ul|ol)>\s*<\1>/g, '');

    // Convert remaining lines to paragraphs
    html = html.split('\n').map(line => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return '';
        if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
            return line;
        }
        return `<p>${line}</p>`;
    }).join('');

    // clean up empty paragraphs and other artifacts
    html = html.replace(/<p>\s*<\/p>/g, '');
    html = html.replace(/<p>(<(ul|ol|h1|h2|h3|div|hr))/g, '$1');
    html = html.replace(/(<\/(ul|ol|h1|h2|h3|div|hr))><\/p>/g, '$1');
    
    return html;
}

async function renderArticle(article: ArticleHistoryItem) {
    currentArticle = article;
    const resultContainer = document.getElementById('result') as HTMLDivElement;
    const initialMessage = document.getElementById('initial-message') as HTMLDivElement;
    const articleOutput = document.getElementById('article-output') as HTMLDivElement;
    const coverImageContainer = document.getElementById('cover-image-container') as HTMLDivElement;
    const videoContainer = document.getElementById('video-container') as HTMLDivElement;
    const videoProgress = document.getElementById('video-progress') as HTMLDivElement;
    const videoPlayer = document.getElementById('video-player') as HTMLVideoElement;
    const videoDownloadLink = document.getElementById('video-download-link') as HTMLAnchorElement;

    stopSpeech();
    stopGeneratedAudio();
    (document.getElementById('audio-player-container') as HTMLDivElement).classList.add('hidden');


    initialMessage.classList.add('hidden');
    resultContainer.classList.remove('hidden');
    
    // Apply creative direction
    const articleWrapper = document.getElementById('article-wrapper') as HTMLDivElement;
    if (article.creativeDirection) {
        articleWrapper.style.setProperty('--article-primary-color', article.creativeDirection.palette[0]);
        articleWrapper.style.setProperty('--article-text-color', article.creativeDirection.palette[1]);
        articleWrapper.style.setProperty('--article-accent-color', article.creativeDirection.palette[2]);
    } else {
        // Reset to default
        articleWrapper.style.removeProperty('--article-primary-color');
        articleWrapper.style.removeProperty('--article-text-color');
        articleWrapper.style.removeProperty('--article-accent-color');
    }

    // Render cover image
    if (article.coverImage) {
        coverImageContainer.innerHTML = `<img src="data:image/jpeg;base64,${article.coverImage}" alt="Cover image for ${article.theme}" class="cover-image">`;
        coverImageContainer.classList.remove('hidden');
    } else {
        coverImageContainer.classList.add('hidden');
    }
    
    // Render markdown to HTML
    if (!article.html) {
        article.html = renderMarkdownToHtml(article.markdown);
        await updateArticleInHistory(article);
    }
    articleOutput.innerHTML = article.html;
    
    // Render images and placeholders
    articleOutput.querySelectorAll('.image-placeholder-wrapper').forEach(wrapper => {
        const key = decodeUnicode((wrapper as HTMLElement).dataset.key || '');
        const imageMapEntry = article.imageMap?.[key];

        if (typeof imageMapEntry === 'string' && imageMapEntry !== 'error') {
            const img = document.createElement('img');
            img.src = `data:image/jpeg;base64,${imageMapEntry}`;
            img.alt = `Generated image for article`;
            img.className = 'generated-image';
            wrapper.replaceWith(img);
        } else if (typeof imageMapEntry === 'object' && imageMapEntry.type === 'screenshot') {
            wrapper.innerHTML = `
                <div class="screenshot-placeholder">
                    <div class="screenshot-placeholder-header">
                        <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2zM4 18V6h16v12H4zm6-10H8v2h2v-2zm4 0h-2v2h2v-2zm4 0h-2v2h2v-2z"/></svg>
                        <span>スクリーンショット挿入指示</span>
                    </div>
                    <p>${imageMapEntry.instruction}</p>
                </div>`;
        } else { // Error or missing
             wrapper.innerHTML = `
                <div class="image-error-placeholder">
                    <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M21.99 4c0-1.1-.89-2-1.99-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4-.01-18zM17 14h-4v-2h4v2zm-6-2h-2v2H7v-2H5V8h2V6h2v2h2v4z"/></svg>
                    <span>画像の生成に失敗しました。</span>
                </div>`;
        }
    });
    
    // Render charts
    articleOutput.querySelectorAll<HTMLCanvasElement>('canvas[data-chart-data]').forEach(canvas => {
        const encodedData = canvas.dataset.chartData;
        if (encodedData) {
            try {
                // Decode from HTML attribute format to valid JSON string
                const decodedData = encodedData.replace(/&quot;/g, '"');
                const chartData = JSON.parse(decodedData);

                const textColor = article.creativeDirection ? article.creativeDirection.palette[1] : '#666';
                const primaryColor = article.creativeDirection ? article.creativeDirection.palette[0] : 'rgba(74, 144, 226, 0.7)';
                const accentColor = article.creativeDirection ? article.creativeDirection.palette[2] : 'rgba(255, 99, 132, 0.7)';
                
                // Define a richer color palette for charts
                const colorPalette = article.creativeDirection ? [primaryColor, accentColor, ...article.creativeDirection.palette.slice(3)] : [
                    'rgba(74, 144, 226, 0.7)',
                    'rgba(75, 192, 192, 0.7)',
                    'rgba(255, 206, 86, 0.7)',
                    'rgba(255, 99, 132, 0.7)',
                    'rgba(153, 102, 255, 0.7)',
                    'rgba(255, 159, 64, 0.7)'
                ];
                
                const borderPalette = colorPalette.map(c => c.replace('0.7', '1'));


                // Assign colors to datasets dynamically
                if (chartData.data.datasets) {
                    chartData.data.datasets.forEach((dataset: any, index: number) => {
                        // For pie, doughnut charts, they take an array of colors for the data points
                        if (['pie', 'doughnut'].includes(chartData.type)) {
                            dataset.backgroundColor = dataset.backgroundColor || chartData.data.labels.map((_: any, i: number) => colorPalette[i % colorPalette.length]);
                            dataset.borderColor = dataset.borderColor || chartData.data.labels.map((_: any, i: number) => borderPalette[i % borderPalette.length]);
                        } else {
                            // For other charts like bar, line, radar
                            const color = colorPalette[index % colorPalette.length];
                            const borderColor = borderPalette[index % borderPalette.length];
                            dataset.backgroundColor = dataset.backgroundColor || color;
                            dataset.borderColor = dataset.borderColor || borderColor;
                        }
                        dataset.borderWidth = dataset.borderWidth || 1;
                    });
                }
                
                const scalesOptions = (chartData.type === 'radar' || chartData.type === 'pie' || chartData.type === 'doughnut') ? {} : {
                    scales: {
                        x: {
                            ticks: { color: textColor },
                            grid: { color: '#e0e0e0' }
                        },
                        y: {
                            ticks: { color: textColor },
                            grid: { color: '#e0e0e0' }
                        }
                    }
                };

                new Chart(canvas, {
                    type: chartData.type,
                    data: chartData.data,
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                            title: {
                                display: true,
                                text: chartData.title,
                                color: textColor,
                                font: { size: 16, family: "'Noto Sans JP', sans-serif" }
                            },
                            legend: {
                                labels: {
                                    color: textColor,
                                    font: { family: "'Noto Sans JP', sans-serif" }
                                }
                            }
                        },
                        ...scalesOptions
                    }
                });
            } catch (e) {
                console.error("Failed to render chart:", e);
                const container = canvas.parentElement;
                if(container) container.innerHTML = `<div class="error">グラフの描画に失敗しました。</div>`;
            }
        }
    });

    // Render video
    videoContainer.classList.toggle('hidden', !article.videoUrl && article.videoStatus !== 'pending');
    videoPlayer.classList.toggle('hidden', !article.videoUrl);
    videoProgress.classList.toggle('hidden', article.videoStatus !== 'pending');
    videoDownloadLink.classList.add('hidden');
    
    if (article.videoStatus === 'pending') {
        videoProgress.textContent = '紹介動画を生成中です... これには数分かかることがあります。';
        if (!videoGenerationPollingInterval) {
            startVideoPolling();
        }
    } else if (article.videoUrl) {
        videoPlayer.src = article.videoUrl;
        videoDownloadLink.href = article.videoUrl;
        videoDownloadLink.classList.remove('hidden');
    }

    // Render FAQs
    const faqContainer = document.getElementById('faq-container') as HTMLDivElement;
    if (article.faqs && article.faqs.length > 0) {
        faqContainer.innerHTML = `<h3 class="enhancement-title">🤔 よくある質問 (Q&A)</h3>` + article.faqs.map(faq => `
            <details class="faq-item">
                <summary class="faq-question">${faq.question}</summary>
                <div class="faq-answer"><p>${faq.answer}</p></div>
            </details>
        `).join('');
        faqContainer.classList.remove('hidden');
    } else {
        faqContainer.classList.add('hidden');
    }

    // Render References
    const referencesContainer = document.getElementById('references-container') as HTMLDivElement;
    const referencesList = document.getElementById('references') as HTMLUListElement;
    if (article.references && article.references.length > 0) {
        referencesList.innerHTML = article.references.map(ref => `<li><a href="${ref.uri}" target="_blank" rel="noopener noreferrer">${ref.title || ref.uri}</a></li>`).join('');
        referencesContainer.classList.remove('hidden');
    } else {
        referencesContainer.classList.add('hidden');
    }

    // Render Enhancements
    const enhancementsContainer = document.getElementById('enhancements-container') as HTMLDivElement;
    if (article.enhancements) {
        (document.getElementById('title-suggestions') as HTMLUListElement).innerHTML = article.enhancements.titleSuggestions.map((t: string) => `<li>${t}</li>`).join('');
        (document.getElementById('sns-output') as HTMLTextAreaElement).value = article.enhancements.snsShareText;
        (document.getElementById('hashtags-output') as HTMLDivElement).innerHTML = article.enhancements.hashtags.map((h: string) => `<span class="hashtag">${h}</span>`).join(' ');
        (document.getElementById('meta-output') as HTMLTextAreaElement).value = article.enhancements.metaDescription;
        enhancementsContainer.classList.remove('hidden');
    } else {
        enhancementsContainer.classList.add('hidden');
    }

    (document.getElementById('expansion-container') as HTMLDivElement).classList.remove('hidden');
    (document.getElementById('expansion-result-container') as HTMLDivElement).classList.add('hidden');

    displayPerformanceAnalysis(article);
    
    const factCheckContainer = document.getElementById('fact-check-container') as HTMLDivElement;
    if (article.factCheck && article.factCheck.status === 'checked') {
        displayFactCheckResults(article.factCheck.results);
        factCheckContainer.classList.remove('hidden');
    } else {
        factCheckContainer.classList.add('hidden');
    }
    
    (document.getElementById('view-mode-container') as HTMLDivElement).classList.remove('hidden');
    (document.getElementById('edit-mode-container') as HTMLDivElement).classList.add('hidden');
}

function displayPerformanceAnalysis(article: ArticleHistoryItem) {
    const container = document.getElementById('performance-analysis-container') as HTMLDivElement;
    const wrapper = document.getElementById('performance-analysis-wrapper') as HTMLDivElement;
    const userInputContainer = document.getElementById('user-input-performance-container') as HTMLDivElement;

    if (!article.performance) {
        container.classList.add('hidden');
        return;
    }
    container.classList.remove('hidden');

    // Display user-inputted performance
    if (article.performance.userInput) {
        userInputContainer.innerHTML = `
            <h4>実績データ (<a href="#" data-id="${article.id}" class="performance-input-link">編集</a>)</h4>
            <div class="user-performance-grid">
                <div class="prediction-item">
                    <div class="value">${article.performance.userInput.views || 'N/A'}</div>
                    <div class="label">閲覧数</div>
                </div>
                <div class="prediction-item">
                    <div class="value">${article.performance.userInput.engagementRate || 'N/A'}%</div>
                    <div class="label">エンゲージメント率</div>
                </div>
                <div class="prediction-item">
                    <div class="value">${article.performance.userInput.conversions || 'N/A'}</div>
                    <div class="label">コンバージョン</div>
                </div>
            </div>
        `;
        userInputContainer.querySelector('.performance-input-link')?.addEventListener('click', (e) => {
            e.preventDefault();
            openPerformanceModal(article.id);
        });
    } else {
        userInputContainer.innerHTML = `<button class="secondary-button" id="add-performance-btn" data-id="${article.id}">+ 実際のパフォーマンスを記録する</button>`;
        userInputContainer.querySelector('#add-performance-btn')?.addEventListener('click', () => openPerformanceModal(article.id));
    }


    // Display AI-generated analysis
    const { qualityScores, personaResonance, engagementPrediction, abTestTitles } = article.performance;
    const getBarColor = (score: number) => score > 80 ? 'green' : score > 50 ? 'orange' : 'red';

    wrapper.innerHTML = `
        <div class="analysis-item">
            <h4><svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/></svg>品質スコア</h4>
            <div class="performance-grid">
                ${Object.entries(qualityScores).map(([key, value]) => `
                    <div class="score-item">
                        <div class="score-title">${key.charAt(0).toUpperCase() + key.slice(1)} (${value.score}/100)</div>
                        <div class="score-bar-container">
                            <div class="score-bar ${getBarColor(value.score)}" style="width: ${value.score}%"></div>
                        </div>
                        <div class="score-feedback">${value.feedback}</div>
                    </div>
                `).join('')}
            </div>
        </div>
        <div class="analysis-item">
            <h4><svg xmlns="http://www.w3.org/2000/svg" enable-background="new 0 0 24 24" height="24px" viewBox="0 0 24 24" width="24px" fill="currentColor"><g><rect fill="none" height="24" width="24"/></g><g><g><path d="M16.5,13c-1.2,0-2.27,0.59-3,1.5c-0.73-0.91-1.8-1.5-3-1.5C8.36,13,7,14.36,7,16.5C7,18.54,9.45,20.88,12,21.5 c2.55-0.62,5-2.96,5-5C17,14.36,15.64,13,16.5,13z"/><path d="M12,12c2.21,0,4-1.79,4-4s-1.79-4-4-4S8,5.79,8,8S9.79,12,12,12z"/></g></g></svg>ペルソナ共鳴度</h4>
            <div class="persona-feedback">${personaResonance.feedback}</div>
        </div>
         <div class="analysis-item">
            <h4><svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6h-6z"/></svg>エンゲージメント予測</h4>
            <div class="engagement-prediction">
                ${Object.entries(engagementPrediction).map(([key, value]) => `
                    <div class="prediction-item">
                        <div class="value">${value}</div>
                        <div class="label">${{likes: "いいね", shares: "シェア", readTime: "読了時間"}[key]}</div>
                    </div>
                `).join('')}
            </div>
        </div>
        <div class="analysis-item">
            <h4><svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M4 18h16V6H4v12zm14-2h-2v-2h2v2zm-4-2h-2v-2h2v2zm-4-2H8v-2h2v2zm-4-2h-2V8h2v2z" opacity=".3"/><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2zM4 18V6h16v12H4zM6 8h2v2H6zm4 0h2v2h-2zm4 0h2v2h-2zm4 2h-2v2h2zm-4 0h-2v2h2zm-4 0H8v2h2z"/></svg>A/Bテスト用タイトル案</h4>
            <ul class="ab-test-titles">
                ${abTestTitles.map(t => `<li><span class="title-text">${t.title}</span> <span class="ctr-prediction">予測CTR: ${t.predictedCTR}</span></li>`).join('')}
            </ul>
        </div>
    `;
}

function displayFactCheckResults(results: FactCheckResult[]) {
    const wrapper = document.getElementById('fact-check-wrapper') as HTMLDivElement;
    if (!results || results.length === 0) {
        wrapper.innerHTML = `<p>検証可能な事実が見つかりませんでした。</p>`;
        return;
    }

    const iconMap = {
        match: '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>',
        partial_match: '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15H9v-2h2v2zm0-4H9V7h2v6z"/></svg>',
        no_match: '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>',
    };
    const titleMap = {
        match: '一致',
        partial_match: '部分的に一致',
        no_match: '一致せず',
    };
    
    wrapper.innerHTML = results.map(r => `
        <div class="fact-check-item ${r.result}">
            <div class="fact-check-header">${iconMap[r.result]} ${titleMap[r.result]}</div>
            <div class="fact-check-statement"><strong>検証対象:</strong> ${r.statement}</div>
            <div class="fact-check-feedback">${r.feedback}</div>
            <div class="fact-check-source"><strong>情報源:</strong> <a href="${r.uri}" target="_blank" rel="noopener noreferrer">${r.source}</a></div>
        </div>
    `).join('');
}
function renderCoPilotSuggestions() {
    const list = document.getElementById('co-pilot-suggestions-list') as HTMLUListElement;
    if (coPilotSuggestions.length === 0) {
        list.innerHTML = '<li>提案はありません。</li>';
        return;
    }
    list.innerHTML = coPilotSuggestions.map(s => `
        <li class="co-pilot-suggestion-item" data-id="${s.id}">
            <strong class="suggestion-reason">${s.reason}</strong>
            <div class="suggestion-diff">
                <span class="original">${s.original}</span>
                <span class="suggested">${s.suggested}</span>
            </div>
            <div class="suggestion-actions">
                <button class="apply-suggestion-btn" data-id="${s.id}">適用</button>
            </div>
        </li>
    `).join('');

    list.querySelectorAll('.apply-suggestion-btn').forEach(button => {
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = parseInt((e.currentTarget as HTMLElement).dataset.id || '-1');
            applySuggestion(id);
        });
    });

    list.querySelectorAll('.co-pilot-suggestion-item').forEach(item => {
        item.addEventListener('mouseenter', () => {
            const id = parseInt((item as HTMLElement).dataset.id || '-1');
            highlightOriginalText(coPilotSuggestions.find(s => s.id === id) || null, true);
        });
        item.addEventListener('mouseleave', () => {
            const id = parseInt((item as HTMLElement).dataset.id || '-1');
            highlightOriginalText(coPilotSuggestions.find(s => s.id === id) || null, false);
        });
    });
}
function applySuggestion(id: number) {
    const suggestion = coPilotSuggestions.find(s => s.id === id);
    const editTextArea = document.getElementById('edit-textarea') as HTMLTextAreaElement;
    if (suggestion && editTextArea) {
        editTextArea.value = editTextArea.value.replace(suggestion.original, suggestion.suggested);
        coPilotSuggestions = coPilotSuggestions.filter(s => s.id !== id);
        renderCoPilotSuggestions();
    }
}
function highlightOriginalText(suggestion: CoPilotSuggestion | null, highlight: boolean) {
    // This is a complex operation in a textarea. For now, we will just highlight the suggestion card.
    const editTextArea = document.getElementById('edit-textarea') as HTMLTextAreaElement;
    document.querySelectorAll('.co-pilot-suggestion-item').forEach(item => item.classList.remove('highlighted'));
    if (suggestion && highlight) {
        const item = document.querySelector(`.co-pilot-suggestion-item[data-id="${suggestion.id}"]`);
        item?.classList.add('highlighted');
    }
}
function showContextMenu(x: number, y: number) {
    const contextMenu = document.getElementById('context-menu') as HTMLDivElement;
    contextMenu.innerHTML = `
        <button id="research-context-btn"><svg xmlns="http://www.w3.org/2000/svg" enable-background="new 0 0 24 24" height="24px" viewBox="0 0 24 24" width="24px" fill="currentColor"><g><rect fill="none" height="24" width="24"/></g><g><g><path d="M15.5,14h-0.79l-0.28-0.27C15.41,12.59,16,11.11,16,9.5C16,5.91,13.09,3,9.5,3S3,5.91,3,9.5C3,13.09,5.91,16,9.5,16 c1.61,0,3.09-0.59,4.23-1.57l0.27,0.28v0.79l5,5L20.49,19L15.5,14z M9.5,14C7.01,14,5,11.99,5,9.5S7.01,5,9.5,5S14,7.01,14,9.5 S11.99,14,9.5,14z"/><path d="M12,10h-2v2H9v-2H7V9h2V7h1v2h2V10z"/></g></g></svg> AIアシスタントで深掘り</button>
    `;
    contextMenu.style.top = `${y}px`;
    contextMenu.style.left = `${x}px`;
    contextMenu.classList.remove('hidden');

    document.getElementById('research-context-btn')?.addEventListener('click', async () => {
        if (!savedSelectionRange) return;
        const selectedText = savedSelectionRange.toString().trim();
        const researchModal = document.getElementById('research-modal') as HTMLDivElement;
        const researchSpinner = document.getElementById('research-spinner') as HTMLDivElement;
        const researchResults = document.getElementById('research-results') as HTMLDivElement;
        const researchOutput = document.getElementById('research-output') as HTMLTextAreaElement;
        const insertResearchBtn = document.getElementById('insert-research-btn') as HTMLButtonElement;
        const researchReferencesContainer = document.getElementById('research-references-container') as HTMLDivElement;
        const researchReferencesList = document.getElementById('research-references') as HTMLUListElement;

        researchModal.classList.remove('hidden');
        researchSpinner.classList.remove('hidden');
        researchResults.classList.add('hidden');
        insertResearchBtn.classList.add('hidden');
        researchOutput.value = '';
        researchReferencesList.innerHTML = '';

        const prompt = `あなたは専門リサーチャーです。以下のテキストについて、Google検索を用いて徹底的に調査し、より詳細な情報や背景、関連データを盛り込んだ解説文を作成してください。

# 調査対象テキスト
---
${sanitizeString(selectedText)}
---
`;
        try {
            const ai = getGenAIClient();
            const response = await withRetry<GenerateContentResponse>(() => ai.models.generateContent({ model: 'gemini-2.5-pro', contents: prompt, config: { tools: [{ googleSearch: {} }] } }));
            researchOutput.value = response.text.trim();
            const references = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
            if (references.length > 0) {
                researchReferencesList.innerHTML = references
                    .filter((r: any) => r.web && r.web.uri)
                    .map((r: any) => `<li><a href="${r.web.uri}" target="_blank" rel="noopener noreferrer">${r.web.title || r.web.uri}</a></li>`)
                    .join('');
                researchReferencesContainer.classList.remove('hidden');
            } else {
                researchReferencesContainer.classList.add('hidden');
            }

            insertResearchBtn.classList.remove('hidden');
            insertResearchBtn.textContent = `「${safeSubstring(selectedText, 10)}」を置き換える`;
        } catch(e) {
            researchOutput.value = "エラーが発生しました。";
        } finally {
            researchSpinner.classList.add('hidden');
            researchResults.classList.remove('hidden');
        }
    });
}
function toggleSpeech() {
    const readAloudButton = document.getElementById('read-aloud-button') as HTMLButtonElement;
    const readAloudTextSpan = readAloudButton.querySelector('.button-text') as HTMLSpanElement | null;
    if (isSpeaking) {
        stopSpeech();
    } else {
        if (!currentArticle) return;
        stopGeneratedAudio();
        const articleOutput = document.getElementById('article-output') as HTMLDivElement;
        const textToSpeak = articleOutput.innerText;
        utterance = new SpeechSynthesisUtterance(textToSpeak);
        utterance.lang = 'ja-JP';
        utterance.onstart = () => {
            isSpeaking = true;
            if(readAloudTextSpan) readAloudTextSpan.textContent = '停止';
        };
        utterance.onend = () => {
            isSpeaking = false;
            utterance = null;
            if(readAloudTextSpan) readAloudTextSpan.textContent = '読み上げ';
        };
        speechSynthesis.speak(utterance);
    }
}
function stopSpeech() {
    if (isSpeaking) {
        speechSynthesis.cancel();
        isSpeaking = false;
        const readAloudTextSpan = document.querySelector('#read-aloud-button .button-text') as HTMLSpanElement | null;
        if(readAloudTextSpan) readAloudTextSpan.textContent = '読み上げ';
    }
}
function stopGeneratedAudio() {
    if (currentAudioSource) {
        currentAudioSource.stop();
        currentAudioSource = null;
    }
    if (currentAudioContext) {
        currentAudioContext.close();
        currentAudioContext = null;
    }
    (document.getElementById('audio-player-container') as HTMLDivElement).innerHTML = '';
}
function openPerformanceModal(articleId: number) {
    const article = articles.find(h => h.id === articleId);
    if (!article) return;
    const performanceModal = document.getElementById('performance-modal') as HTMLDivElement;
    const performanceViewsInput = document.getElementById('performance-views') as HTMLInputElement;
    const performanceEngagementRateInput = document.getElementById('performance-engagement-rate') as HTMLInputElement;
    const performanceConversionsInput = document.getElementById('performance-conversions') as HTMLInputElement;

    currentPerformanceArticleId = articleId;
    performanceViewsInput.value = article.performance?.userInput?.views || '';
    performanceEngagementRateInput.value = article.performance?.userInput?.engagementRate || '';
    performanceConversionsInput.value = article.performance?.userInput?.conversions || '';
    performanceModal.classList.remove('hidden');
}
async function repurposeContent(article: ArticleHistoryItem, format: 'twitter' | 'youtube' | 'presentation', button: HTMLButtonElement) {
    const spinner = button.querySelector('.spinner') as HTMLDivElement;
    const buttonText = button.querySelector('.button-text') as HTMLSpanElement;
    const originalText = buttonText.textContent;
    const expansionResultContainer = document.getElementById('expansion-result-container') as HTMLDivElement;
    const expansionOutput = document.getElementById('expansion-output') as HTMLTextAreaElement;

    button.disabled = true;
    spinner.classList.remove('hidden');
    buttonText.textContent = '変換中...';
    expansionResultContainer.classList.add('hidden');

    let prompt = `あなたはプロのコンテンツマーケターです。以下の記事本文を、指定されたフォーマットに最適化して書き直してください。元の記事の要点とトーンは維持してください。

# 元記事
---
${safeSubstring(sanitizeString(article.markdown), 5000)}
---
`;

    switch (format) {
        case 'twitter':
            prompt += `\n# 指示\nこの記事の内容を、X (Twitter) で投稿するための魅力的なスレッド形式（5〜8ツイート）に変換してください。各ツイートは140字以内で、絵文字を効果的に使用してください。最初のツイートは読者の興味を引くフックにしてください。`;
            break;
        case 'youtube':
            prompt += `\n# 指示\nこの記事の内容を元に、約5分間のYouTube動画用の台本を作成してください。オープニング、本編、クロージングの構成で、視聴者が飽きないような話し口調で記述してください。ト書き（映像の指示）も適宜追加してください。`;
            break;
        case 'presentation':
            prompt += `\n# 指示\nこの記事の内容を、ビジネスプレゼンテーション用の構成案に変換してください。タイトル、アジェンダ、各スライドの要点（箇条書き）を明確に示してください。合計で約10枚のスライドになるように構成してください。`;
            break;
    }

    try {
        const ai = getGenAIClient();
        const response = await withRetry<GenerateContentResponse>(() => ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt }));
        expansionOutput.value = response.text;
        expansionResultContainer.classList.remove('hidden');
    } catch(e) {
        expansionOutput.value = "コンテンツの変換中にエラーが発生しました。";
        expansionResultContainer.classList.remove('hidden');
    } finally {
        button.disabled = false;
        spinner.classList.add('hidden');
        buttonText.textContent = originalText;
    }

}
function handleFile(file: File) {
    const fileInfoDiv = document.getElementById('file-info') as HTMLDivElement;
    const referenceTextArea = document.getElementById('reference-text') as HTMLTextAreaElement;
    
    if (file.type !== "text/plain" && file.type !== "text/markdown") {
        alert("テキストファイル (.txt, .md) のみアップロードできます。");
        return;
    }
    
    fileInfoDiv.innerHTML = `
        <span>${file.name}</span>
        <button id="remove-file-btn">&times;</button>
    `;
    fileInfoDiv.classList.remove('hidden');
    
    document.getElementById('remove-file-btn')?.addEventListener('click', () => {
        (document.getElementById('file-upload-input') as HTMLInputElement).value = '';
        referenceTextArea.value = '';
        fileInfoDiv.classList.add('hidden');
    });

    const reader = new FileReader();
    reader.onload = (e) => {
        referenceTextArea.value = e.target?.result as string;
    };
    reader.readAsText(file);
}

// --- Helper & Utility Functions ---
function safeSubstring(str: string, length: number): string { return str.length > length ? str.substring(0, length) + '...' : str; }
function sanitizeString(str: string): string { return str.replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function encodeUnicode(str: string) { return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (match, p1) => String.fromCharCode(parseInt(p1, 16))));}
function decodeUnicode(str: string) { try { return decodeURIComponent(atob(str).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')); } catch(e) { return str; } }
async function withRetry<T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> { for (let i = 0; i < retries; i++) { try { return await fn(); } catch (e) { if (i === retries - 1) throw e; await new Promise(res => setTimeout(res, delay * (i + 1))); } } throw new Error("Retry logic failed"); }
function setLoading(isLoading: boolean, message: string | null = null) { const form = document.getElementById('article-form') as HTMLFormElement; const analyzePersonaBtn = document.getElementById('analyze-persona-btn') as HTMLButtonElement; const spinner = analyzePersonaBtn.querySelector('.spinner') as HTMLDivElement; const progressContainer = document.getElementById('progress') as HTMLDivElement; analyzePersonaBtn.disabled = isLoading; spinner.classList.toggle('hidden', !isLoading); if (isLoading) { if (message) { progressContainer.innerHTML = `<div class="progress-step active"><div class="step-spinner"></div><span>${message}</span></div>`; } } else { progressContainer.innerHTML = ''; } }
function resetUI() { const r = document.getElementById('result') as HTMLDivElement; const i = document.getElementById('initial-message') as HTMLDivElement; r.classList.add('hidden'); i.classList.remove('hidden'); r.querySelector('#article-output')!.innerHTML = ''; }
function updateProgress(stepIndex: number) { const progressContainer = document.getElementById('progress') as HTMLDivElement; progressContainer.innerHTML = progressSteps.map((step, index) => { let statusClass = ''; let icon = '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"/></svg>'; if (index < stepIndex) { statusClass = 'completed'; icon = '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>'; } else if (index === stepIndex) { statusClass = 'active'; icon = '<div class="step-spinner"></div>'; } return `<div class="progress-step ${statusClass}">${icon}<span>${step}</span></div>`; }).join(''); }
function decode(base64: string) { const binaryString = atob(base64); const len = binaryString.length; const bytes = new Uint8Array(len); for (let i = 0; i < len; i++) { bytes[i] = binaryString.charCodeAt(i); } return bytes; }
async function decodeAudioData(data: Uint8Array, ctx: AudioContext, sampleRate: number, numChannels: number,): Promise<AudioBuffer> { const dataInt16 = new Int16Array(data.buffer); const frameCount = dataInt16.length / numChannels; const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate); for (let channel = 0; channel < numChannels; channel++) { const channelData = buffer.getChannelData(channel); for (let i = 0; i < frameCount; i++) { channelData[i] = dataInt16[i * numChannels + channel] / 32768.0; } } return buffer; }
function bufferToWave(abuffer: AudioBuffer, len: number): Blob { let numOfChan = abuffer.numberOfChannels, length = len * numOfChan * 2 + 44, buffer = new ArrayBuffer(length), view = new DataView(buffer), channels = [], i, sample, offset = 0, pos = 0; setUint32(0x46464952); setUint32(length - 8); setUint32(0x45564157); setUint32(0x20746d66); setUint32(16); setUint16(1); setUint16(numOfChan); setUint32(abuffer.sampleRate); setUint32(abuffer.sampleRate * 2 * numOfChan); setUint16(numOfChan * 2); setUint16(16); setUint32(0x61746164); setUint32(length - pos - 4); for (i = 0; i < abuffer.numberOfChannels; i++) channels.push(abuffer.getChannelData(i)); while (pos < length) { for (i = 0; i < numOfChan; i++) { sample = Math.max(-1, Math.min(1, channels[i][offset])); sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0; view.setInt16(pos, sample, true); pos += 2; } offset++; } function setUint16(data: number) { view.setUint16(pos, data, true); pos += 2; } function setUint32(data: number) { view.setUint32(pos, data, true); pos += 4; } return new Blob([view], { type: 'audio/wav' }); }

// --- Storage & API Key Logic ---
function getApiKey(): string | null { return apiKey; }
function saveApiKey(key: string) { apiKey = key; localStorage.setItem('geminiApiKey', key); }
function clearApiKey() { apiKey = null; localStorage.removeItem('geminiApiKey'); }
function getGenAIClient(): GoogleGenAI { const key = getApiKey(); if (!key) throw new Error("APIキーが設定されていません。"); return new GoogleGenAI({ apiKey: key }); }
function setApiKeyStatus(message: string, type: 'success' | 'error') { const apiKeyStatus = document.getElementById('api-key-status') as HTMLDivElement; apiKeyStatus.textContent = message; apiKeyStatus.className = `api-key-status ${type}`; apiKeyStatus.style.display = 'block'; }
// FIX: The variable initialMessage was not in scope. Defined it inside the function.
function checkApiKeyOnLoad() {
    const initialMessage = document.getElementById('initial-message') as HTMLDivElement;
    const key = localStorage.getItem('geminiApiKey');
    const form = document.getElementById('article-form') as HTMLFormElement;
    const analyzePersonaBtn = document.getElementById('analyze-persona-btn') as HTMLButtonElement;
    if (key) {
        apiKey = key;
        form.style.opacity = '1';
        analyzePersonaBtn.disabled = false;
        (initialMessage.querySelector('p') as HTMLParagraphElement).textContent = `左のフォームに情報を入力するか、「戦略立案モード」でAIの提案を受けて、高品質な記事の自動生成を始めましょう。`;
    } else {
        form.style.opacity = '0.5';
        analyzePersonaBtn.disabled = true;
        (initialMessage.querySelector('p') as HTMLParagraphElement).innerHTML = `APIキーが設定されていません。<br>右上の<strong style="color: var(--primary-color);">設定</strong>ボタンからAPIキーを設定してください。`;
    }
}
function loadArticlesFromStorage() { const stored = localStorage.getItem('articleHistory'); if (stored) { articles = JSON.parse(stored); } }
function saveArticlesToStorage() { try { localStorage.setItem('articleHistory', JSON.stringify(articles)); } catch (e) { console.error("Failed to save history to localStorage:", e); alert("履歴の保存に失敗しました。ストレージの空き容量が不足している可能性があります。"); } }
async function addArticleToHistory(item: ArticleHistoryItem) { const { coverImage, imageMap, ...itemWithoutImages } = item; await saveImagesToDb(item.id, coverImage, imageMap); articles.unshift(itemWithoutImages); if (articles.length > 50) { const oldestItem = articles.pop(); if (oldestItem) { await deleteImagesFromDb(oldestItem.id); } } saveArticlesToStorage(); renderHistoryList(); }
async function updateArticleInHistory(updatedArticle: ArticleHistoryItem) { const { coverImage, imageMap, ...itemWithoutImages } = updatedArticle; await saveImagesToDb(updatedArticle.id, coverImage, imageMap); const index = articles.findIndex(a => a.id === updatedArticle.id); if (index !== -1) { articles[index] = itemWithoutImages; saveArticlesToStorage(); renderHistoryList(); } }
async function removeArticleFromHistory(id: number) { articles = articles.filter(a => a.id !== id); await deleteImagesFromDb(id); saveArticlesToStorage(); renderHistoryList(); if(currentArticle && currentArticle.id === id) { resetUI(); } }
function loadBrandVoiceFromStorage() { const stored = localStorage.getItem('brandVoice'); if (stored) { brandVoice = JSON.parse(stored); (document.getElementById('brand-voice-principles') as HTMLTextAreaElement).value = brandVoice.principles; (document.getElementById('brand-voice-example') as HTMLTextAreaElement).value = brandVoice.example; } }
function saveBrandVoiceToStorage() { brandVoice.principles = (document.getElementById('brand-voice-principles') as HTMLTextAreaElement).value; brandVoice.example = (document.getElementById('brand-voice-example') as HTMLTextAreaElement).value; localStorage.setItem('brandVoice', JSON.stringify(brandVoice)); }

// FIX: This function was a single line causing multiple syntax errors. Reformatted for clarity and correctness.
async function renderHistoryList() {
    const list = document.getElementById('history-list') as HTMLUListElement;
    if (articles.length === 0) {
        list.innerHTML = `<li class="history-empty">作成履歴はありません。</li>`;
        return;
    }
    list.innerHTML = ''; // Clear list before rendering
    for (const item of articles) {
        const li = document.createElement('li');
        li.className = 'history-item';
        li.dataset.id = String(item.id);
        const { coverImage } = await getImagesFromDb(item.id);
        li.innerHTML = `
            <div class="history-item-thumbnail" style="background-image: url(${coverImage ? `data:image/jpeg;base64,${coverImage}` : ''})"></div>
            <div class="history-item-content">
                <span class="history-item-title">${item.theme}</span>
                <div class="history-item-price ${item.price ? '' : 'not-for-sale'}">${item.price ? `¥${item.price.toLocaleString()}` : '非売品'}</div>
                <div class="history-item-details">
                    <span class="history-item-date">${item.createdAt}</span>
                    ${item.scheduledAt ? `<span class="scheduled-badge"><svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 0 24 24" width="16px" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1V1h-2zm3 18H5V8h14v11z"/></svg> 予約済</span>` : ''}
                    ${item.lastCheckedForUpdate ? `<span class="history-item-date checked-date"><svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 0 24 24" width="16px" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>最終チェック: ${new Date(item.lastCheckedForUpdate).toLocaleDateString('ja-JP')}</span>` : ''}
                </div>
            </div>
            <div class="history-item-actions">
                <button class="preview-btn" data-id="${item.id}">プレビュー</button>
                <button class="edit-btn" data-id="${item.id}">編集</button>
                <button class="performance-input-btn" data-id="${item.id}">実績入力</button>
                <button class="update-check-btn" data-id="${item.id}" title="更新をチェック">🔄</button>
                <button class="delete-history-btn" data-id="${item.id}" title="削除">🗑️</button>
            </div>
        `;
        list.appendChild(li);
    }
    list.querySelectorAll('.edit-btn').forEach(el => el.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = Number((el as HTMLElement).dataset.id);
        const articleStub = articles.find(a => a.id === id);
        if (articleStub) {
            switchMode('create');
            const articleOutput = document.getElementById('article-output') as HTMLDivElement;
            articleOutput.innerHTML = `<div class="step-spinner"></div> 記事を読み込んでいます...`;
            resetUI();
            (document.getElementById('result') as HTMLDivElement).classList.remove('hidden');
            (document.getElementById('initial-message') as HTMLDivElement).classList.add('hidden');
            articleOutput.parentElement?.classList.remove('hidden');
            const imageData = await getImagesFromDb(id);
            const article = { ...articleStub, ...imageData };
            renderArticle(article);
        }
    }));
    list.querySelectorAll('.delete-history-btn').forEach(el => el.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = Number((el as HTMLElement).dataset.id);
        if (confirm('この商品を削除しますか？')) removeArticleFromHistory(id);
    }));
    list.querySelectorAll('.update-check-btn').forEach(el => el.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = Number((el as HTMLElement).dataset.id);
        handleContentAudit(id);
    }));
    list.querySelectorAll('.performance-input-btn').forEach(el => el.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = Number((el as HTMLElement).dataset.id);
        openPerformanceModal(id);
    }));
    list.querySelectorAll('.preview-btn').forEach(el => el.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = Number((el as HTMLElement).dataset.id);
        renderProductPreview(id);
    }));
}

async function renderProductPreview(articleId: number) {
    const productPreviewModal = document.getElementById('product-preview-modal') as HTMLDivElement;
    const articleStub = articles.find(a => a.id === articleId);
    if (!articleStub || !productPreviewModal) return;

    const imageData = await getImagesFromDb(articleId);
    const article = { ...articleStub, ...imageData };

    const titleEl = productPreviewModal.querySelector('.product-preview-title') as HTMLHeadingElement;
    const imageEl = productPreviewModal.querySelector('.product-preview-image') as HTMLImageElement;
    const descriptionEl = productPreviewModal.querySelector('.product-preview-description') as HTMLParagraphElement;
    const priceEl = productPreviewModal.querySelector('.product-preview-price') as HTMLSpanElement;
    const buyBtn = productPreviewModal.querySelector('.product-preview-buy-btn') as HTMLButtonElement;

    if(!titleEl || !imageEl || !descriptionEl || !priceEl || !buyBtn) {
        console.error("Product preview modal is missing required child elements. Opening article directly.");
        renderArticle(article);
        switchMode('create');
        return;
    }

    titleEl.textContent = article.theme;
    if (article.coverImage) {
        imageEl.src = `data:image/jpeg;base64,${article.coverImage}`;
        imageEl.style.display = 'block';
    } else {
        imageEl.style.display = 'none';
    }
    descriptionEl.textContent = article.productDescription || '商品説明がありません。';
    
    if (article.price && article.articleType === 'paid') {
        priceEl.textContent = `¥${article.price.toLocaleString()}`;
        buyBtn.textContent = '購入する';
        buyBtn.disabled = false;
    } else {
        priceEl.textContent = '無料';
        buyBtn.textContent = '続きを読む';
        buyBtn.disabled = false;
    }

    const buyClickHandler = () => {
        productPreviewModal.classList.add('hidden');
        renderArticle(article);
        switchMode('create');
        buyBtn.removeEventListener('click', buyClickHandler);
    };
    buyBtn.addEventListener('click', buyClickHandler);
    
    productPreviewModal.classList.remove('hidden');
}


// --- Content Audit Function ---
// FIX: This function was a single line causing multiple syntax errors. Reformatted for clarity and correctness.
async function handleContentAudit(articleId: number) {
    const article = articles.find(a => a.id === articleId);
    if (!article) return;

    currentAuditArticleId = articleId;
    currentAuditSuggestions = [];
    const auditModal = document.getElementById('audit-modal') as HTMLDivElement;
    const auditSpinner = document.getElementById('audit-spinner') as HTMLDivElement;
    const auditResults = document.getElementById('audit-results') as HTMLDivElement;
    const editWithSuggestionsBtn = document.getElementById('edit-with-suggestions-btn') as HTMLButtonElement;


    auditModal.classList.remove('hidden');
    auditSpinner.classList.remove('hidden');
    auditResults.classList.add('hidden');
    editWithSuggestionsBtn.classList.add('hidden');
    auditResults.innerHTML = '';

    const prompt = `あなたは優秀なコンテンツエディターです。あなたの仕事は、以下の記事が今日現在でも情報として最新かつ正確であるかを確認することです。
1. Google検索を使い、記事の主要テーマ「${sanitizeString(article.theme)}」に関する最新の情報を調査してください。特に、記事内で言及されている統計、日付、製品名、イベントなどに注目してください。
2. 調査結果と記事本文を比較してください。
3. 記事を更新するための、具体的で実行可能な提案のリストをJSON形式で生成してください。もし記事が最新で更新不要な場合は、その旨をJSONで示してください。

# JSON出力スキーマ
{
  "is_fresh": true,
  "suggestions": [
    {
      "area": "更新が必要な箇所（例：見出し「2023年のトレンド」）",
      "reason": "更新が必要な理由（例：データが古く、2024年の新しい情報があるため）",
      "suggestion_text": "具体的な更新案（例：「2023年」を「2024年」に更新し、新しいトレンドとして〇〇を追加するべきです。」）"
    }
  ]
}

# 記事本文
---
${safeSubstring(sanitizeString(article.markdown), 10000)}
---
`;
    try {
        const ai = getGenAIClient();
        const response = await withRetry<GenerateContentResponse>(() => ai.models.generateContent({
            model: 'gemini-2.5-pro',
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                tools: [{ googleSearch: {} }]
            }
        }));
        let jsonText = response.text.trim();
        if (jsonText.startsWith('```json')) {
            jsonText = jsonText.substring(7);
            if (jsonText.endsWith('```')) {
                jsonText = jsonText.substring(0, jsonText.length - 3);
            }
        }
        const result = JSON.parse(jsonText);
        
        if (result.is_fresh) {
            auditResults.innerHTML = `
                <div class="audit-fresh-message">
                    <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/></svg>
                    <span>素晴らしい！この記事は現在でも最新の状態です。</span>
                </div>
            `;
        } else {
            currentAuditSuggestions = result.suggestions || [];
            auditResults.innerHTML = currentAuditSuggestions.map(s => `
                <div class="audit-suggestion">
                    <strong>エリア: ${s.area}</strong>
                    <p class="reason">${s.reason}</p>
                    <p class="suggestion-text">${s.suggestion_text}</p>
                </div>
            `).join('');
            if (currentAuditSuggestions.length > 0) {
                editWithSuggestionsBtn.classList.remove('hidden');
            }
        }
        
        const fullArticle = { ...article, ...(await getImagesFromDb(article.id)) };
        fullArticle.lastCheckedForUpdate = new Date().toISOString();
        await updateArticleInHistory(fullArticle);

    } catch (error) {
        console.error("Error during content audit:", error);
        auditResults.innerHTML = `<p class="error">コンテンツの監査中にエラーが発生しました。</p>`;
    } finally {
        auditSpinner.classList.add('hidden');
        auditResults.classList.remove('hidden');
    }
}

function startVideoPolling() {
    if (videoGenerationPollingInterval) {
        clearInterval(videoGenerationPollingInterval);
    }

    videoGenerationPollingInterval = window.setInterval(async () => {
        const articleInProgress = articles.find(a => a.videoStatus === 'pending' && a.videoOperationName);
        if (!articleInProgress) {
            if (videoGenerationPollingInterval) clearInterval(videoGenerationPollingInterval);
            videoGenerationPollingInterval = null;
            return;
        }
        
        try {
            const ai = getGenAIClient();
            // FIX: Cast operation to 'any' to accommodate properties like 'done' and 'response' from the API call.
            let operation: any = { name: articleInProgress.videoOperationName! }; // Create a shell operation object
            operation = await ai.operations.getVideosOperation({ operation });
            
            const fullArticle = { ...articleInProgress, ...(await getImagesFromDb(articleInProgress.id)) };

            if (operation.done) {
                if (videoGenerationPollingInterval) clearInterval(videoGenerationPollingInterval);
                videoGenerationPollingInterval = null;

                if (operation.response) {
                    const downloadLink = operation.response?.generatedVideos?.[0]?.video?.uri;
                    if (downloadLink) {
                        const response = await fetch(`${downloadLink}&key=${getApiKey()}`);
                        const videoBlob = await response.blob();
                        const videoUrl = URL.createObjectURL(videoBlob);
                        
                        fullArticle.videoUrl = videoUrl;
                        fullArticle.videoStatus = 'completed';
                    } else {
                         fullArticle.videoStatus = 'failed';
                    }
                } else { // It's done but has no response, so it failed.
                    fullArticle.videoStatus = 'failed';
                    console.error('Video operation finished with an error:', operation.error);
                }

                await updateArticleInHistory(fullArticle);
                if (currentArticle?.id === fullArticle.id) {
                    renderArticle(fullArticle);
                }
            }
        } catch (error) {
            console.error("Error polling for video status:", error);
            const fullArticle = { ...articleInProgress, ...(await getImagesFromDb(articleInProgress.id)) };
            fullArticle.videoStatus = 'failed';
            await updateArticleInHistory(fullArticle);
            if (currentArticle?.id === fullArticle.id) {
                renderArticle(fullArticle);
            }
            if (videoGenerationPollingInterval) clearInterval(videoGenerationPollingInterval);
            videoGenerationPollingInterval = null;
        }
    }, 10000); // Poll every 10 seconds
}

async function generateVideo(article: ArticleHistoryItem) {
    const veoKeySelection = document.getElementById('veo-key-selection') as HTMLDivElement;
    try {
        const hasKey = await (window as any).aistudio.hasSelectedApiKey();
        if (!hasKey) {
            veoKeySelection.classList.remove('hidden');
            return;
        }
        veoKeySelection.classList.add('hidden');

        article.videoStatus = 'pending';
        await updateArticleInHistory(article);
        renderArticle(article); // Re-render to show progress

        const ai = getGenAIClient();

        const prompt = `Create a short, engaging video summary based on the following article theme and content. The style should be dynamic and visually appealing. Article theme: "${article.theme}".`;

        let operation = await ai.models.generateVideos({
            model: 'veo-3.1-fast-generate-preview',
            prompt: prompt,
            image: article.coverImage ? {
                imageBytes: article.coverImage,
                mimeType: 'image/jpeg',
            } : undefined,
            config: {
                numberOfVideos: 1,
                resolution: '720p',
                aspectRatio: '16:9'
            }
        });

        article.videoOperationName = operation.name;
        await updateArticleInHistory(article);
        startVideoPolling();

    } catch (error: any) {
        console.error("Error starting video generation:", error);
        if (error.message.includes("Requested entity was not found")) {
            veoKeySelection.classList.remove('hidden');
        }
        article.videoStatus = 'failed';
// FIX: The end of the file was corrupted. Fixed the catch block and closed the function properly.
        await updateArticleInHistory(article);
        renderArticle(article);
    }
}
