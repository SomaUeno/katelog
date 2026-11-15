(() => {
  "use strict";

  const DB_NAME = "genryo-note";
  const DB_VERSION = 2;
  const BACKUP_VERSION = 2;
  // 入力値の上限（入力・保存・復元のすべてで使う。input 要素の min / max / maxlength も同じ値にする）
  const LIMITS = {
    calories: 99999.9,          // 食品の栄養値（基準量あたり・100gあたり）と、1件の食事記録の計算後の値（kcal）
    nutrient: 9999.9,           // タンパク質・脂質・炭水化物（g）。同上
    dayCalories: 99999.9,       // 1日の合計（kcal）
    dayNutrient: 9999.9,        // 1日の合計のタンパク質・脂質・炭水化物（g）
    amountMin: 0.01, amountMax: 9999.99,   // 食事の数量・食品の基準量
    nameLength: 80, unitLength: 12,        // 食品名（前後の空白を除く）・単位の文字数
    dateMin: "2000-01-01", dateMax: "2099-12-31",
    weightMin: 0.1, weightMax: 999.9,      // 体重・目標体重（入力。0.1kg単位）
    backupWeightMax: 999.99,               // 復元では古い0.01kg単位の値も受け付ける
    backupFileBytes: 50 * 1024 * 1024      // 復元できるバックアップファイルの大きさ
  };
  const NUTRIENT_FIELDS = [
    ["calories", "カロリー", "kcal"], ["protein", "タンパク質", "g"], ["fat", "脂質", "g"], ["carbohydrate", "炭水化物", "g"]
  ];
  const LIMIT_EPSILON = 1e-6; // 掛け算・足し算の誤差（99999.90000000001 など）を上限超えとしない

  // day が true のときは1日の合計の上限、それ以外は食品の栄養値・1件の食事記録の上限
  function nutrientMax(key, day = false) {
    if (day) return key === "calories" ? LIMITS.dayCalories : LIMITS.dayNutrient;
    return key === "calories" ? LIMITS.calories : LIMITS.nutrient;
  }

  function limitText(value) {
    return value.toLocaleString("ja-JP", { maximumFractionDigits: 2 });
  }

  // 食品の値（食品マスター・今日限りの食品）を確かめ、問題があればメッセージを返す
  function foodValueError({ name, unit, baseAmount, calories, protein, fat, carbohydrate }) {
    if (!name) return "食品名を入力してください。";
    if (name.length > LIMITS.nameLength) return `食品名は${LIMITS.nameLength}文字以内で入力してください。`;
    if (!unit) return "単位を入力してください。";
    if (unit.length > LIMITS.unitLength) return `単位は${LIMITS.unitLength}文字以内で入力してください。`;
    if (!inRange(baseAmount, LIMITS.amountMin, LIMITS.amountMax)) return `基準量は${limitText(LIMITS.amountMin)}〜${limitText(LIMITS.amountMax)}の範囲で入力してください。`;
    const values = { calories, protein, fat, carbohydrate };
    for (const [key, label, unitLabel] of NUTRIENT_FIELDS) {
      if (!inRange(values[key], 0, nutrientMax(key))) return `${label}は0〜${limitText(nutrientMax(key))} ${unitLabel}の範囲で入力してください。`;
    }
    return "";
  }

  function amountError(amount) {
    return inRange(amount, LIMITS.amountMin, LIMITS.amountMax) ? "" : `数量は${limitText(LIMITS.amountMin)}〜${limitText(LIMITS.amountMax)}の範囲で入力してください。`;
  }

  function inRange(value, min, max) {
    return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
  }

  // 1件の食事記録（day = false）・1日の合計（day = true）の栄養値が上限以内か
  function withinNutritionLimits(values, day = false) {
    return NUTRIENT_FIELDS.every(([key]) => {
      const value = values[key] || 0;
      return Number.isFinite(value) && value >= 0 && value <= nutrientMax(key, day) + LIMIT_EPSILON;
    });
  }

  const NUTRITION_LIMIT_TEXT = `カロリー${limitText(LIMITS.calories)} kcal、タンパク質・脂質・炭水化物${limitText(LIMITS.nutrient)} g`;
  const DAY_LIMIT_TEXT = `カロリー${limitText(LIMITS.dayCalories)} kcal、タンパク質・脂質・炭水化物${limitText(LIMITS.dayNutrient)} g`;
  const MEAL_LIMIT_MESSAGE = `1件の栄養値が上限（${NUTRITION_LIMIT_TEXT}）を超えます。数量を確認してください。`;
  const DAY_LIMIT_MESSAGE = `1日の合計が上限（${DAY_LIMIT_TEXT}）を超えます。数量を確認してください。`;

  // 1日の合計から元の記録（before）を除き、新しい値（after）を足したものが上限以内か
  function dayTotalWithin(date, after, before = null) {
    const total = totalsFor(date);
    const next = {};
    for (const [key] of NUTRIENT_FIELDS) next[key] = total[key] - (before ? before[key] || 0 : 0) + (after[key] || 0);
    return withinNutritionLimits(next, true);
  }
  // showGoalLine：体重グラフの目標の線の表示（凡例の「目標」で切り替える。終了日が目標日のとき以外に使う）。ない古いデータでは false
  const DEFAULT_SETTINGS = {
    id: "app", goalWeight: null, targetDate: "",
    chartRangeMode: "auto", chartStart: "", chartEnd: "",
    showGoalLine: false
  };
  // v87 で使っていたグラフの期間（chartPeriod）の値。読み替え（normalizeChartSettings）と復元の検査だけに使う
  const LEGACY_CHART_PERIODS = ["week", "month", "3months", "all", "goal", "custom"];
  // 以前のバージョンの設定の項目（グラフの傾向線・記録・目標の表示）。復元では true / false なら受け付けて無視し、端末の設定からも外す
  const OBSOLETE_SETTING_KEYS = ["showWeight", "showTrend", "showGoal"];
  const $ = (selector, root = document) => root.querySelector(selector);
  const app = $("#page-content");
  const tabs = [...document.querySelectorAll(".tab")];
  const state = { page: "today", date: localDate(), historyMonth: "", foods: [], meals: [], weights: [], settings: { ...DEFAULT_SETTINGS }, search: "", todayFoodSearch: "", foodSort: "name", composingSearch: false }; // foodSort："name"（名前順）または "protein-desc" のような「栄養素-desc/asc」
  let toastTimer;

  function localDate(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function isValidDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    if (value < LIMITS.dateMin || value > LIMITS.dateMax) return false; // 2000-01-01〜2099-12-31
    const parsed = new Date(`${value}T00:00:00`);
    return !Number.isNaN(parsed.getTime()) && localDate(parsed) === value;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function numberText(value, digits = 1) {
    return Number(value).toLocaleString("ja-JP", { maximumFractionDigits: digits });
  }

  // 表示用に小数1桁へ丸める（計算や保存には使わない）。72.55 のように2進数では 72.5499… になる値も
  // 10進数として四捨五入するため、指数表記の文字列を経由する
  function roundTenth(value) {
    const rounded = Math.round(Number(`${value}e1`)) / 10;
    return Number.isFinite(rounded) ? rounded : Math.round(value * 10) / 10;
  }

  // 栄養成分・合計・PFCの％：最大で小数1桁、末尾の0は付けない（例：234、3.8、12.9）
  function nutrientText(value) {
    return Number.isFinite(value) ? roundTenth(value).toLocaleString("ja-JP", { maximumFractionDigits: 1 }) : "0";
  }

  // 体重・目標体重：いつも小数1桁（例：72.0）。保存済みの0.01kg単位の値も表示だけ丸める
  function kgText(value) {
    return roundTenth(value).toLocaleString("ja-JP", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }

  // 体重の入力欄に入れる値（区切りの「,」を付けない）
  function kgInputValue(value) {
    return roundTenth(value).toFixed(1);
  }

  function makeId() {
    return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      let blocked = false;
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("foods")) database.createObjectStore("foods", { keyPath: "id" });
        if (!database.objectStoreNames.contains("meals")) database.createObjectStore("meals", { keyPath: "id" });
        if (!database.objectStoreNames.contains("weights")) database.createObjectStore("weights", { keyPath: "date" });
        if (!database.objectStoreNames.contains("settings")) database.createObjectStore("settings", { keyPath: "id" });
      };
      request.onblocked = () => {
        blocked = true;
        reject(new Error("別のタブで古いアプリが開いています。ほかのカテログのタブを閉じてから再読み込みしてください。"));
      };
      request.onsuccess = () => {
        if (blocked) return request.result.close();
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error || new Error("端末内データベースを開けませんでした。"));
    });
  }

  let databasePromise;
  function database() {
    if (!databasePromise) databasePromise = openDatabase();
    return databasePromise;
  }

  async function readStore(storeName) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("端末内データを読み込めませんでした。"));
    });
  }

  async function putRecord(storeName, record) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(record);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("保存に失敗しました。入力内容を確認して再度お試しください。"));
      transaction.onabort = () => reject(transaction.error || new Error("保存が取り消されました。"));
    });
  }

  async function deleteRecord(storeName, key) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).delete(key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("削除に失敗しました。"));
      transaction.onabort = () => reject(transaction.error || new Error("削除が取り消されました。"));
    });
  }

  async function deleteHistoryRecords(dates) {
    const dateSet = new Set(dates);
    if (!dateSet.size) return;
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["meals", "weights"], "readwrite");
      const mealsStore = transaction.objectStore("meals");
      const weightsStore = transaction.objectStore("weights");
      for (const meal of state.meals) {
        if (dateSet.has(meal.date)) mealsStore.delete(meal.id);
      }
      for (const weight of state.weights) {
        if (dateSet.has(weight.date)) weightsStore.delete(weight.date);
      }
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("履歴の削除に失敗しました。"));
      transaction.onabort = () => reject(transaction.error || new Error("履歴の削除が取り消されました。"));
    });
  }

  async function replaceAll(data) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["foods", "meals", "weights", "settings"], "readwrite");
      for (const storeName of ["foods", "meals", "weights", "settings"]) {
        const store = transaction.objectStore(storeName);
        store.clear();
        if (storeName === "settings") store.put(data.settings);
        else data[storeName].forEach(item => store.put(item));
      }
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("復元に失敗しました。既存データは変更されていません。"));
      transaction.onabort = () => reject(transaction.error || new Error("復元が取り消されました。既存データは変更されていません。"));
    });
  }

  function showToast(message, isError = false) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.style.background = isError ? "#8b3434" : "";
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
  }

  async function refreshData() {
    const [foods, meals, weights, settings] = await Promise.all([
      readStore("foods"), readStore("meals"), readStore("weights"), readStore("settings")
    ]);
    const normalizedFoods = foods.map(food => ({
      ...food,
      ...(food.type === "weight" ? { baseAmount: 100, unit: "g" } : {}),
      fat: Number.isFinite(food.fat) ? food.fat : 0,
      carbohydrate: Number.isFinite(food.carbohydrate) ? food.carbohydrate : 0
    }));
    await Promise.all(normalizedFoods
      .filter((food, index) => food.baseAmount !== foods[index].baseAmount || food.unit !== foods[index].unit ||
        food.fat !== foods[index].fat || food.carbohydrate !== foods[index].carbohydrate)
      .map(food => putRecord("foods", food)));
    state.foods = normalizedFoods;
    state.meals = meals.map(meal => ({
      ...meal,
      fatPerUnit: Number.isFinite(meal.fatPerUnit) ? meal.fatPerUnit : 0,
      carbohydratePerUnit: Number.isFinite(meal.carbohydratePerUnit) ? meal.carbohydratePerUnit : 0,
      fat: Number.isFinite(meal.fat) ? meal.fat : 0,
      carbohydrate: Number.isFinite(meal.carbohydrate) ? meal.carbohydrate : 0
    }));
    state.weights = weights;
    state.settings = { ...DEFAULT_SETTINGS, ...(settings.find(item => item.id === "app") || {}) };
    OBSOLETE_SETTING_KEYS.forEach(key => delete state.settings[key]);
    Object.assign(state.settings, normalizeChartSettings(state.settings, weights.map(item => item.date).filter(isValidDate).sort()[0]));
    delete state.settings.chartPeriod;
    state.foods.sort((a, b) => a.name.localeCompare(b.name, "ja"));
    state.meals.sort((a, b) => a.createdAt - b.createdAt);
  }

  async function saveSettings(settings) {
    const updated = { ...settings, id: "app" };
    await putRecord("settings", updated);
    state.settings = updated;
  }

  function mealsFor(date) {
    return state.meals.filter(meal => meal.date === date);
  }

  function totalsFor(date) {
    return mealsFor(date).reduce((total, meal) => ({
      calories: total.calories + (meal.calories || 0),
      protein: total.protein + (meal.protein || 0),
      fat: total.fat + (meal.fat || 0),
      carbohydrate: total.carbohydrate + (meal.carbohydrate || 0)
    }), { calories: 0, protein: 0, fat: 0, carbohydrate: 0 });
  }

  function pfcPercentages(total) {
    const p = (total.protein || 0) * 4;
    const f = (total.fat || 0) * 9;
    const c = (total.carbohydrate || 0) * 4;
    const sum = p + f + c;
    if (!sum) return { protein: 0, fat: 0, carbohydrate: 0 };
    return { protein: p / sum * 100, fat: f / sum * 100, carbohydrate: c / sum * 100 };
  }

  function renderPfc(total) {
    const pfc = pfcPercentages(total);
    return `<div class="pfc-balance" aria-label="PFCバランス">
      <span class="nutrition-protein">P ${nutrientText(pfc.protein)}%</span><span class="nutrition-fat">F ${nutrientText(pfc.fat)}%</span><span class="nutrition-carbohydrate">C ${nutrientText(pfc.carbohydrate)}%</span>
    </div>`;
  }

  function render() {
    tabs.forEach(tab => tab.classList.toggle("active", tab.dataset.page === state.page));
    if (state.page === "today") renderToday();
    else if (state.page === "history") renderHistory();
    else if (state.page === "foods") renderFoods();
    else renderBackup();
  }

  function renderToday() {
    const date = state.date;
    const meals = mealsFor(date);
    const total = totalsFor(date);
    const weight = state.weights.find(item => item.date === date);
    app.innerHTML = `
      <div class="page">
        <div class="day-heading"><div class="day-picker"><svg class="day-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg><h2 id="day-title">${escapeHtml(dayHeading(date))}</h2><input class="day-picker-input" id="daily-date" type="date" min="2000-01-01" max="2099-12-31" value="${date}" aria-label="記録日" aria-describedby="day-title${date === localDate() ? " day-today" : ""}"></div><div class="day-status">${date === localDate()
          ? `<span id="day-today" class="day-today">今日</span>`
          : `<button type="button" id="back-to-today" class="day-back"><svg class="day-back-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>今日に戻る</button>`}</div></div>
        <div class="totals" aria-label="本日の合計">
          <div class="nutrition-calorie"><span class="total-label">合計カロリー</span><strong class="total-value">${meals.length ? `${nutrientText(total.calories)}<span class="total-unit">kcal</span>` : "未記録"}</strong></div>
          <div class="nutrition-protein"><span class="total-label">タンパク質</span><strong class="total-value">${meals.length ? `${nutrientText(total.protein)}<span class="total-unit">g</span>` : "未記録"}</strong></div>
          <div class="nutrition-fat"><span class="total-label">脂質</span><strong class="total-value">${meals.length ? `${nutrientText(total.fat)}<span class="total-unit">g</span>` : "未記録"}</strong></div>
          <div class="nutrition-carbohydrate"><span class="total-label">炭水化物</span><strong class="total-value">${meals.length ? `${nutrientText(total.carbohydrate)}<span class="total-unit">g</span>` : "未記録"}</strong></div>
        </div>
        ${renderPfc(total)}
        <section class="card weight-row">
          <h2>体重</h2><input id="weight-value" class="weight-input" type="number" min="0.1" max="999.9" step="0.1" inputmode="decimal" placeholder="未記録" value="${weight ? kgInputValue(weight.kg) : ""}" aria-label="体重（kg）"><span class="unit-label">kg</span>
          <button id="save-weight" class="button secondary small" type="button">保存</button>${weight ? '<button id="delete-weight" class="button danger small" type="button">削除</button>' : ""}
        </section>
        <section class="card">
          <div class="meal-top"><h2>食事</h2><button id="copy-meal" class="button secondary small" type="button">ほかの日の食事をコピー</button></div>
          <form id="add-meal-form" class="add-food" novalidate>
            <div class="field"><span id="food-picker-field-label">食品</span><button id="food-picker-open" class="food-picker-trigger" type="button" aria-haspopup="dialog" aria-labelledby="food-picker-field-label food-picker-open" ${state.foods.length ? "" : "disabled"}><span class="food-picker-trigger-text">${state.foods.length ? "食品を選択" : "食品マスターに登録してください"}</span></button><input type="hidden" name="foodId" value=""></div>
            <label class="field" id="amount-label">数量<input name="amount" type="number" min="0.01" max="9999.99" step="any" inputmode="decimal" required placeholder="例：1"></label>
            <button class="button primary add-button" type="submit" ${state.foods.length ? "" : "disabled"}>追加</button>
          </form>
          <button id="quick-food" class="button secondary quick-food-button" type="button">手入力で追加</button>
          ${meals.length ? `<div class="meal-list">${meals.map(renderMeal).join("")}</div>` : `<div class="empty">この日の食事はまだ記録されていません。</div>`}
          ${meals.length ? `<button id="delete-today-meals" class="button danger small clear-today-button" type="button">食事をすべて削除</button>` : ""}
        </section>
      </div>`;
    const dateInput = $("#daily-date");
    keepDateResetOnOpen(dateInput);
    // ほかの日を開いているときの「今日に戻る」（日付の input の外に置いているので、押してもピッカーは開かない）
    $("#back-to-today")?.addEventListener("click", () => { state.date = localDate(); render(); });
    // iOS の日付ピッカーは日付を押した時点で change を起こすので、タッチ操作の環境では change・input では切り替えず、
    // ピッカーを閉じて欄からフォーカスが外れたとき（blur）に切り替える。マウス操作の環境は PC のピッカーが選ぶとすぐ閉じて blur が起きないため change で切り替える
    const touchPicker = matchMedia("(hover: none), (pointer: coarse)").matches;
    // 見出しのまわりのフォーカスの枠はキーボードで操作したときだけ（日付の input は押しても :focus-visible になるため、指・マウスで押したことを覚えておく）
    const picker = dateInput.closest(".day-picker");
    // 押している間は見出し全体を少し薄くする（is-pressed）
    dateInput.addEventListener("pointerdown", () => picker.classList.add("by-pointer", "is-pressed"));
    ["pointerup", "pointercancel", "pointerleave"].forEach(type => dateInput.addEventListener(type, () => picker.classList.remove("is-pressed")));
    dateInput.addEventListener("keydown", () => picker.classList.remove("by-pointer"));
    dateInput.addEventListener("blur", () => picker.classList.remove("by-pointer", "is-pressed"));
    // 欄の値で記録する日を切り替える（blur・change の両方から呼ぶ）。空なら今日に戻る（iOS のバージョンによって「リセット」で空になる場合）、
    // 範囲外ならエラーで元に戻す、それ以外は state.date を変えて描き直す。今の日付と同じなら何もしない（同じ値で2回描き直さない。描き直すと input 要素ごと作り直す）
    const applyDate = () => {
      const value = dateInput.value === "" ? localDate() : dateInput.value;
      if (value === state.date) { dateInput.value = state.date; return; }
      if (!isValidDate(value)) {
        dateInput.value = state.date;
        return showToast("日付は2000/01/01〜2099/12/31の範囲で入力してください。", true);
      }
      state.date = value;
      render();
    };
    if (touchPicker) dateInput.addEventListener("blur", applyDate);
    else {
      dateInput.addEventListener("change", applyDate);
      // 空になったとき input だけが起きる場合のため。input で受け取るのは空のときだけ（PC で日付を打っている途中にエラーを出さないため）
      dateInput.addEventListener("input", () => { if (dateInput.value === "") applyDate(); });
    }
    $("#food-picker-open").addEventListener("click", openFoodPicker);
    $("#add-meal-form").addEventListener("submit", addMeal);
    $("#save-weight").addEventListener("click", saveWeight);
    $("#delete-weight")?.addEventListener("click", deleteWeight);
    $("#copy-meal").addEventListener("click", openCopyDialog);
    $("#quick-food").addEventListener("click", openQuickFoodDialog);
    $("#delete-today-meals")?.addEventListener("click", deleteTodayMeals);
    app.querySelectorAll("[data-meal-amount]").forEach(input => input.addEventListener("change", updateMealAmount));
    // click の event.detail はキーボード（Enter・Space）で押したとき 0。開き方によってメニューの最初のフォーカスを変える
    app.querySelectorAll("[data-meal-menu]").forEach(button => button.addEventListener("click", event => openMealMenu(button.dataset.mealMenu, event.detail === 0)));
  }

  function updateAmountLabel(foodId) {
    const food = state.foods.find(item => item.id === foodId);
    const label = $("#amount-label");
    if (!label) return;
    const unit = food?.type === "unit" ? food.unit : "g";
    label.innerHTML = `数量（${escapeHtml(unit)}）<input name="amount" type="number" min="0.01" max="9999.99" step="any" inputmode="decimal" required placeholder="例：1">`;
  }

  function renderMeal(meal) {
    const unit = meal.type === "unit" ? meal.unit : "g";
    // 食品マスターに紐づかない記録（今日限りの食品とそのコピー）には小さく「今日限り」と表示する（表示だけ）
    const isTemporary = meal.foodId == null;
    const temporary = isTemporary ? ' <span class="meal-temporary">手入力</span>' : "";
    // マスターの記録は「数量：[入力欄] 単位」の行で数量を変える。手入力の記録は文字だけで表示する。
    // 編集・削除は右上の「⋯」のメニュー（マスター＝削除、手入力＝編集／削除）。カードそのものは押しても何もしない
    const amountRow = isTemporary
      ? `<div class="meal-amount">数量：${numberText(meal.amount, 3)} ${escapeHtml(unit)}${temporary}</div>`
      : `<label class="meal-amount meal-amount-edit"><span class="meal-amount-label">数量：</span><input class="quantity-input" type="number" min="0.01" max="9999.99" step="any" inputmode="decimal" value="${escapeHtml(meal.amount)}" data-meal-amount="${escapeHtml(meal.id)}" aria-label="${escapeHtml(meal.foodName)}の数量"><span class="meal-amount-unit">${escapeHtml(unit)}</span></label>`;
    return `<article class="meal-item">
      <div class="card-body">
        <div class="meal-main"><div class="meal-name">${escapeHtml(meal.foodName)}</div>${amountRow}</div>
        <div class="meal-nutrients nutrient-grid"><span class="nutrition-calorie">カロリー ${nutrientText(meal.calories)} kcal</span><span class="nutrition-protein">タンパク質 ${nutrientText(meal.protein)} g</span><span class="nutrition-fat">脂質 ${nutrientText(meal.fat || 0)} g</span><span class="nutrition-carbohydrate">炭水化物 ${nutrientText(meal.carbohydrate || 0)} g</span></div>
      </div>
      <button class="more-button" type="button" data-meal-menu="${escapeHtml(meal.id)}" aria-haspopup="dialog" aria-label="${escapeHtml(meal.foodName)}の操作">⋯</button>
    </article>`;
  }

  function calculateMealNutrition(type, amount, caloriesPerUnit, proteinPerUnit, fatPerUnit = 0, carbohydratePerUnit = 0) {
    const factor = type === "unit" ? amount : amount / 100;
    const calories = caloriesPerUnit * factor;
    const protein = proteinPerUnit * factor;
    const fat = fatPerUnit * factor;
    const carbohydrate = carbohydratePerUnit * factor;
    if (![calories, protein, fat, carbohydrate].every(Number.isFinite)) {
      throw new Error("数量が大きすぎるため栄養値を計算できません。数量を確認してください。");
    }
    return { calories, protein, fat, carbohydrate };
  }

  async function addMeal(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const food = state.foods.find(item => item.id === form.elements.foodId.value);
    const amount = Number(form.elements.amount.value);
    if (!food) return showToast("食品を選択してください。", true);
    if (amountError(amount)) return showToast(amountError(amount), true);
    let nutrition;
    try { nutrition = calculateMealNutrition(food.type, amount, food.calories, food.protein, food.fat || 0, food.carbohydrate || 0); }
    catch (error) { return showToast(error.message, true); }
    if (!withinNutritionLimits(nutrition)) return showToast(MEAL_LIMIT_MESSAGE, true);
    if (!dayTotalWithin(state.date, nutrition)) return showToast(DAY_LIMIT_MESSAGE, true);
    const meal = {
      id: makeId(), date: state.date, foodId: food.id, foodName: food.name, type: food.type,
      unit: food.type === "unit" ? food.unit : "g", amount,
      caloriesPerUnit: food.calories, proteinPerUnit: food.protein, fatPerUnit: food.fat || 0, carbohydratePerUnit: food.carbohydrate || 0,
      calories: nutrition.calories, protein: nutrition.protein, fat: nutrition.fat, carbohydrate: nutrition.carbohydrate, createdAt: Date.now()
    };
    try {
      await putRecord("meals", meal);
      await refreshData();
      render();
      showToast("食事を記録しました。");
    } catch (error) { showToast(error.message, true); }
  }

  async function updateMealAmount(event) {
    const input = event.currentTarget;
    const meal = state.meals.find(item => item.id === input.dataset.mealAmount);
    const amount = Number(input.value);
    if (!meal || amountError(amount)) {
      showToast(meal ? amountError(amount) : "記録が見つかりません。", true);
      render();
      return;
    }
    let nutrition;
    try { nutrition = calculateMealNutrition(meal.type, amount, meal.caloriesPerUnit, meal.proteinPerUnit, meal.fatPerUnit || 0, meal.carbohydratePerUnit || 0); }
    catch (error) { showToast(error.message, true); render(); return; }
    const limitMessage = !withinNutritionLimits(nutrition) ? MEAL_LIMIT_MESSAGE : !dayTotalWithin(meal.date, nutrition, meal) ? DAY_LIMIT_MESSAGE : "";
    if (limitMessage) {
      showToast(limitMessage, true);
      render();
      return;
    }
    const updated = {
      ...meal,
      amount,
      calories: nutrition.calories,
      protein: nutrition.protein,
      fat: nutrition.fat,
      carbohydrate: nutrition.carbohydrate
    };
    try { await putRecord("meals", updated); await refreshData(); render(); }
    catch (error) { showToast(error.message, true); }
  }

  // 食事の記録1件の削除（消えるのはその1件だけなので確認しない）
  async function deleteMeal(id) {
    try { await deleteRecord("meals", id); await refreshData(); render(); showToast("食事記録を削除しました。"); }
    catch (error) { showToast(error.message, true); }
  }

  // 食事カードの「⋯」のメニュー：マスターの記録は削除、手入力の記録は編集／削除
  function openMealMenu(id, viaKeyboard = false) {
    const meal = state.meals.find(item => item.id === id);
    if (!meal) return;
    const isTemporary = meal.foodId == null;
    const unit = meal.type === "unit" ? meal.unit : "g";
    openActionSheet({
      title: meal.foodName,
      detail: `${isTemporary ? "手入力・" : ""}数量：${numberText(meal.amount, 3)} ${unit}`,
      actions: [
        ...(isTemporary ? [{ label: "編集", run: () => openQuickFoodEditDialog(meal.id, viaKeyboard) }] : []),
        { label: "削除", danger: true, run: () => deleteMeal(meal.id) }
      ],
      viaKeyboard
    });
  }

  // 操作のメニュー（画面の下から出すアクションシート）。静的な <dialog id="action-sheet"> を showModal で開く。
  // 文字は textContent で入れる（HTMLとして解釈しない）。削除などの危険な操作は赤い文字で、ほかの操作のあと（いちばん下）に置く。
  // 開いている間は検索シートと同じ方法で後ろのページのスクロールを止める。操作を選ぶと、メニューを閉じてから実行する（dialog を重ねない）。
  // 最初のフォーカスは「削除」に入れない（Enter の連打で消えないように）：キーボードで開いたときはキャンセル（枠を出す）、
  // 指・マウスで開いたときは dialog 自体（tabindex="-1"、枠なし）に置く
  function openActionSheet({ title, detail, actions, viaKeyboard = false }) {
    const dialog = $("#action-sheet");
    $("#action-sheet-title").textContent = title;
    $("#action-sheet-detail").textContent = detail;
    const list = $("#action-sheet-actions");
    list.replaceChildren();
    const normal = actions.filter(action => !action.danger);
    const danger = actions.filter(action => action.danger);
    const addButton = action => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `action-sheet-action${action.danger ? " danger" : ""}`;
      button.textContent = action.label;
      button.addEventListener("click", () => { closeActionSheet(); action.run(); });
      list.append(button);
    };
    normal.forEach(addButton);
    danger.forEach(addButton);
    lockSheetScroll();
    dialog.showModal();
    (viaKeyboard ? dialog.querySelector(".action-sheet-cancel") : dialog).focus({ preventScroll: true });
  }

  function closeActionSheet() {
    const dialog = $("#action-sheet");
    if (dialog.open) dialog.close();
    unlockSheetScroll();
  }

  // mealId が空なら新規追加、値があればその今日限りの記録の編集（見出し・説明・ボタンを切り替える）
  function setQuickFoodMode(mealId) {
    const form = $("#quick-food-form");
    const editing = Boolean(mealId);
    form.elements.mealId.value = mealId || "";
    $("#quick-food-title").textContent = editing ? "手入力の食品を編集" : "手入力で追加";
    $("#quick-food-description").textContent = editing
      ? "この記録だけを修正します。食品マスターやほかの記録は変わりません。"
      : "食品マスターには登録せず、この記録だけに使います。";
    $("#quick-food-submit").textContent = editing ? "保存" : "記録に追加";
  }

  // 入力用のダイアログ（食品の登録・編集、手入力、ほかの日の食事をコピー）を開く。showModal は最初の操作できる要素（「×」）に
  // フォーカスを置くので、指・マウスで開いたときは dialog 自体（tabindex="-1"、枠なし）にフォーカスを移す（入力欄にはフォーカスしない）。
  // キーボードで開いたとき（click の event.detail が 0）は、そのまま「×」に置いて緑の枠を出す
  function showFormDialog(dialog, viaKeyboard) {
    dialog.showModal();
    if (!viaKeyboard) dialog.focus({ preventScroll: true });
  }

  // click のイベントから、キーボード（Enter・Space）で押したかどうかを返す
  function clickedByKeyboard(event) {
    return Boolean(event) && event.detail === 0;
  }

  function openQuickFoodDialog(event) {
    const form = $("#quick-food-form");
    form.reset();
    setQuickFoodMode("");
    form.elements.amount.value = "1";
    updateQuickFoodFields();
    showFormDialog($("#quick-food-dialog"), clickedByKeyboard(event));
  }

  function openQuickFoodEditDialog(mealId, viaKeyboard = false) {
    const meal = state.meals.find(item => item.id === mealId);
    if (!meal || meal.foodId != null) return showToast("編集する記録が見つかりません。", true);
    const form = $("#quick-food-form");
    form.reset();
    setQuickFoodMode(meal.id);
    const isWeight = meal.type === "weight";
    form.elements.name.value = meal.foodName;
    form.elements.type.value = isWeight ? "weight" : "unit";
    // 食事記録には基準量が保存されていないため、固定商品は基準量1（単位あたりの値）として入れる
    form.elements.baseAmount.value = isWeight ? "100" : "1";
    form.elements.unit.value = isWeight ? "g" : meal.unit;
    form.elements.calories.value = String(meal.caloriesPerUnit);
    form.elements.protein.value = String(meal.proteinPerUnit);
    form.elements.fat.value = String(meal.fatPerUnit || 0);
    form.elements.carbohydrate.value = String(meal.carbohydratePerUnit || 0);
    form.elements.amount.value = String(meal.amount);
    updateQuickFoodFields();
    showFormDialog($("#quick-food-dialog"), viaKeyboard);
  }

  function updateQuickFoodFields() {
    const form = $("#quick-food-form");
    const isWeight = form.elements.type.value === "weight";
    form.elements.baseAmount.readOnly = isWeight;
    form.elements.unit.readOnly = isWeight;
    if (isWeight) {
      form.elements.baseAmount.value = "100";
      form.elements.unit.value = "g";
    }
    $("#quick-weight-hint").hidden = !isWeight;
    $("#quick-calorie-label").textContent = isWeight ? "100gあたり" : "基準量あたり";
    $("#quick-protein-label").textContent = isWeight ? "100gあたり" : "基準量あたり";
    $("#quick-fat-label").textContent = isWeight ? "100gあたり" : "基準量あたり";
    $("#quick-carbohydrate-label").textContent = isWeight ? "100gあたり" : "基準量あたり";
    $("#quick-amount-label").firstChild.textContent = `${form.elements.mealId.value ? "数量" : "追加する数量"}（${isWeight ? "g" : form.elements.unit.value || "単位"}）`;
  }

  function changeQuickFoodType() {
    const form = $("#quick-food-form");
    if (form.elements.type.value === "unit") {
      form.elements.baseAmount.value = "1";
      form.elements.unit.value = "個";
    }
    updateQuickFoodFields();
  }

  async function saveQuickFood(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = form.elements.name.value.trim();
    const type = form.elements.type.value;
    const baseAmount = type === "unit" ? Number(form.elements.baseAmount.value) : 100;
    const unit = type === "unit" ? form.elements.unit.value.trim() : "g";
    const amount = Number(form.elements.amount.value);
    const calories = Number(form.elements.calories.value);
    const protein = Number(form.elements.protein.value);
    const fat = Number(form.elements.fat.value);
    const carbohydrate = Number(form.elements.carbohydrate.value);
    const valueError = foodValueError({ name, unit, baseAmount, calories, protein, fat, carbohydrate }) || amountError(amount);
    if (valueError) return showToast(valueError, true);
    let nutrition;
    try { nutrition = calculateMealNutrition(type, amount, calories, protein, fat, carbohydrate); }
    catch (error) { return showToast(error.message, true); }
    if (!withinNutritionLimits(nutrition)) return showToast(MEAL_LIMIT_MESSAGE, true);
    const mealId = form.elements.mealId.value;
    // 編集では元の記録（今日限り＝foodId が null のもの）の id・日付・作成日時を引き継ぐ
    const original = mealId ? state.meals.find(item => item.id === mealId && item.foodId == null) : null;
    if (mealId && !original) return showToast("編集する記録が見つかりません。", true);
    const values = {
      foodName: name, type, unit, amount,
      caloriesPerUnit: calories, proteinPerUnit: protein, fatPerUnit: fat, carbohydratePerUnit: carbohydrate,
      ...nutrition
    };
    const meal = original
      ? { ...original, ...values, foodId: null }
      : { id: makeId(), date: state.date, foodId: null, ...values, temporary: true, createdAt: Date.now() };
    // 編集では元の記録を合計から除いてから新しい値を足す（二重に数えない）
    if (!dayTotalWithin(meal.date, meal, original)) return showToast(DAY_LIMIT_MESSAGE, true);
    try {
      await putRecord("meals", meal);
      await refreshData();
      $("#quick-food-dialog").close();
      render();
      showToast(original ? "手入力の食品を更新しました。" : "手入力の食品を記録しました。");
    } catch (error) { showToast(error.message, true); }
  }

  async function deleteTodayMeals() {
    const meals = mealsFor(state.date);
    if (!meals.length || !confirm(`${dateLabel(state.date)}の食事記録${meals.length}件を削除しますか？`)) return;
    try {
      const db = await database();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("meals", "readwrite");
        meals.forEach(meal => transaction.objectStore("meals").delete(meal.id));
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("この日の食事記録の削除に失敗しました。"));
        transaction.onabort = () => reject(transaction.error || new Error("この日の食事記録の削除が取り消されました。"));
      });
      await refreshData();
      render();
      showToast("この日の食事記録を削除しました。");
    } catch (error) { showToast(error.message, true); }
  }

  async function saveWeight() {
    const input = $("#weight-value");
    const raw = input.value.trim();
    // 0.1kg単位で記録する（保存済みの0.01kg単位の値は、保存し直したときだけ丸まる）
    const kg = roundTenth(Number(raw));
    if (!raw || !Number.isFinite(kg) || kg <= 0 || kg > 999.9) return showToast("体重は0.1〜999.9kgで入力してください。", true);
    const record = { date: state.date, kg };
    try { await putRecord("weights", record); await refreshData(); render(); showToast("体重を保存しました。"); }
    catch (error) { showToast(error.message, true); }
  }

  async function deleteWeight() {
    if (!confirm("この日の体重記録を削除しますか？")) return;
    try { await deleteRecord("weights", state.date); await refreshData(); render(); showToast("体重記録を削除しました。"); }
    catch (error) { showToast(error.message, true); }
  }

  function openFoodDialog(food = null, viaKeyboard = false) {
    const dialog = $("#food-dialog");
    const form = $("#food-form");
    form.reset();
    form.elements.id.value = food?.id || "";
    form.elements.name.value = food?.name || "";
    form.elements.type.value = food?.type || "unit";
    form.elements.baseAmount.value = food?.baseAmount ?? 1;
    form.elements.unit.value = food?.unit || "個";
    form.elements.calories.value = food?.calories ?? "";
    form.elements.protein.value = food?.protein ?? "";
    form.elements.fat.value = food?.fat ?? "";
    form.elements.carbohydrate.value = food?.carbohydrate ?? "";
    $("#food-dialog-title").textContent = food ? "食品を編集" : "食品を登録";
    // 操作の行の左端の「削除」は編集のときだけ（新規登録ではキャンセル・保存だけ）
    $("#food-delete").hidden = !food;
    $("#food-delete").setAttribute("aria-label", food ? `${food.name}を削除` : "削除");
    updateFoodFields();
    updateFoodDuplicateNote();
    showFormDialog(dialog, viaKeyboard);
  }

  function updateFoodFields() {
    const form = $("#food-form");
    const type = form.elements.type.value;
    const isWeight = type === "weight";
    form.elements.baseAmount.readOnly = isWeight;
    form.elements.unit.readOnly = isWeight;
    if (isWeight) {
      form.elements.baseAmount.value = "100";
      form.elements.unit.value = "g";
    }
    $("#weight-hint").hidden = !isWeight;
    form.elements.name.placeholder = isWeight ? "例：鶏むね肉" : "例：納豆"; // 食品名の例は記録のしかたに合わせる
    $("#calorie-label").textContent = isWeight ? "100gあたり" : "基準量あたり";
    $("#protein-label").textContent = isWeight ? "100gあたり" : "基準量あたり";
    $("#fat-label").textContent = isWeight ? "100gあたり" : "基準量あたり";
    $("#carbohydrate-label").textContent = isWeight ? "100gあたり" : "基準量あたり";
  }

  // 新規登録で、同じ名前（前後の空白を除いて完全一致）の食品があれば注意を出す（保存は止めない）
  function updateFoodDuplicateNote() {
    const form = $("#food-form");
    const name = form.elements.name.value.trim();
    $("#food-duplicate-note").hidden = !(!form.elements.id.value && name && state.foods.some(food => food.name.trim() === name));
  }

  function changeFoodType() {
    const form = $("#food-form");
    if (form.elements.type.value === "unit") {
      form.elements.baseAmount.value = "1";
      form.elements.unit.value = "個";
    }
    updateFoodFields();
  }

  async function saveFood(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = form.elements.name.value.trim();
    const type = form.elements.type.value;
    const baseAmount = type === "unit" ? Number(form.elements.baseAmount.value) : 100;
    const unit = type === "unit" ? form.elements.unit.value.trim() : "g";
    const calories = Number(form.elements.calories.value);
    const protein = Number(form.elements.protein.value);
    const fat = Number(form.elements.fat.value);
    const carbohydrate = Number(form.elements.carbohydrate.value);
    if (!form.elements.calories.value.trim() || !form.elements.protein.value.trim() ||
        !form.elements.fat.value.trim() || !form.elements.carbohydrate.value.trim()) {
      return showToast("栄養値をすべて入力してください。", true);
    }
    const valueError = foodValueError({ name, unit, baseAmount, calories, protein, fat, carbohydrate });
    if (valueError) return showToast(valueError, true);

    // 紐づく食事記録を新しい値で計算し直す。どれかの記録、またはどれかの日の合計が上限を超えるときは、編集全体を保存しない
    function recalculatedMeals(food) {
      const updated = [];
      const overDates = new Set();
      const linkedDates = new Set();
      for (const meal of state.meals) {
        if (meal.foodId !== food.id) continue;
        let nutrition;
        try { nutrition = calculateMealNutrition(food.type, meal.amount, food.calories, food.protein, food.fat, food.carbohydrate); }
        catch { overDates.add(meal.date); continue; }
        if (!withinNutritionLimits(nutrition)) overDates.add(meal.date);
        linkedDates.add(meal.date);
        updated.push({
          ...meal, foodName: food.name, type: food.type, unit: food.type === "unit" ? food.unit : "g",
          caloriesPerUnit: food.calories, proteinPerUnit: food.protein, fatPerUnit: food.fat,
          carbohydratePerUnit: food.carbohydrate, ...nutrition
        });
      }
      for (const date of linkedDates) {
        const total = { calories: 0, protein: 0, fat: 0, carbohydrate: 0 };
        for (const meal of state.meals) {
          if (meal.date !== date) continue;
          const source = updated.find(item => item.id === meal.id) || meal;
          for (const [key] of NUTRIENT_FIELDS) total[key] += source[key] || 0;
        }
        if (!withinNutritionLimits(total, true)) overDates.add(date);
      }
      if (overDates.size) {
        const dates = [...overDates].sort();
        const shown = dates.slice(0, 5).map(dateLabel).join("、") + (dates.length > 5 ? ` ほか${dates.length - 5}日` : "");
        throw new Error(`この値にすると、${shown}の${NUTRITION_LIMIT_TEXT === DAY_LIMIT_TEXT ? `記録または1日の合計が上限（${NUTRITION_LIMIT_TEXT}）` : `記録（上限：${NUTRITION_LIMIT_TEXT}）または1日の合計（上限：${DAY_LIMIT_TEXT}）が上限`}を超えるため、保存できません。`);
      }
      return updated;
    }

    async function saveFoodAndUpdateMeals(food, previous) {
      const updatedMeals = previous ? recalculatedMeals(food) : [];
      const db = await database();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(["foods", "meals"], "readwrite");
        transaction.objectStore("foods").put(food);
        updatedMeals.forEach(meal => transaction.objectStore("meals").put(meal));
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("食品の保存と過去記録の更新に失敗しました。"));
        transaction.onabort = () => reject(transaction.error || new Error("食品の保存と過去記録の更新が取り消されました。"));
      });
    }
    const previous = state.foods.find(item => item.id === form.elements.id.value);
    const food = { id: previous?.id || makeId(), name, type, baseAmount, unit, calories, protein, fat, carbohydrate, updatedAt: Date.now() };
    try {
      await saveFoodAndUpdateMeals(food, previous);
      await refreshData();
      $("#food-dialog").close();
      render();
      showToast(previous ? "食品を更新しました。過去の記録にも反映しました。" : "食品を登録しました。");
    } catch (error) { showToast(error.message, true); }
  }

  // 食品と紐づく食事記録の削除（ほかの記録も一緒に消えるので、件数を示して確認する）。削除したら true
  async function deleteFood(foodId) {
    const food = state.foods.find(item => item.id === foodId);
    const linkedMeals = state.meals.filter(meal => meal.foodId === food?.id);
    if (!food || !confirm(`「${food.name}」を食品マスターから削除しますか？\n紐づく食事記録${linkedMeals.length}件も削除されます。`)) return false;
    try {
      const db = await database();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(["foods", "meals"], "readwrite");
        transaction.objectStore("foods").delete(food.id);
        linkedMeals.forEach(meal => transaction.objectStore("meals").delete(meal.id));
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("食品と食事記録の削除に失敗しました。"));
        transaction.onabort = () => reject(transaction.error || new Error("食品と食事記録の削除が取り消されました。"));
      });
      await refreshData(); render(); showToast("食品と紐づく食事記録を削除しました。");
      return true;
    }
    catch (error) { showToast(error.message, true); return false; }
  }

  // 食品マスターのカードは管理用なので、カードのどこを押しても編集が開く（透明な button をカード全体に重ねる）
  function foodCardMarkup(food) {
    return `<article class="food-card">
        <button type="button" class="food-open" data-edit-food="${escapeHtml(food.id)}" aria-label="${escapeHtml(food.name)}を編集"></button>
        <div class="food-main">
          <div class="meal-name">${escapeHtml(food.name)}</div>
          <div class="food-nutrition">
            <div class="food-basis">${food.type === "unit" ? `${numberText(food.baseAmount, 2)} ${escapeHtml(food.unit)}あたり` : "100gあたり"}</div>
            <div class="food-nutrients nutrient-grid">
              <span class="nutrition-calorie"><small>カロリー</small><strong>${nutrientText(food.calories)} kcal</strong></span>
              <span class="nutrition-protein"><small>タンパク質</small><strong>${nutrientText(food.protein)} g</strong></span>
              <span class="nutrition-fat"><small>脂質</small><strong>${nutrientText(food.fat || 0)} g</strong></span>
              <span class="nutrition-carbohydrate"><small>炭水化物</small><strong>${nutrientText(food.carbohydrate || 0)} g</strong></span>
            </div>
            ${foodSortValueMarkup(food)}
          </div>
        </div>
        <span class="food-chevron" aria-hidden="true"></span>
      </article>`;
  }

  // 並び替えの値（"protein-desc" など）を栄養素と向きに分ける。名前順は nutrient が null
  function foodSortParts(sort) {
    const [nutrient, direction] = String(sort).split("-");
    return ["protein", "fat", "carbohydrate"].includes(nutrient) && ["asc", "desc"].includes(direction) ? { nutrient, direction } : { nutrient: null, direction: "asc" };
  }

  // 1kcalあたりの栄養素の量（並べる元の数）。カロリーが0以下の食品は null（並び順では0として扱う）
  function foodNutrientRatio(food, nutrient) {
    const calories = Number(food.calories);
    return calories > 0 ? Number(food[nutrient] || 0) / calories : null;
  }

  // 栄養素で並べているときだけ、カードに並べる元の数を「100kcalあたり 20.5g」（小数1桁、栄養素の色）で出す。カロリー0は「—」
  function foodSortValueMarkup(food) {
    const { nutrient } = foodSortParts(state.foodSort);
    if (!nutrient) return "";
    const ratio = foodNutrientRatio(food, nutrient);
    return `<div class="food-sort-value nutrition-${nutrient}">100kcalあたり ${ratio === null ? "—" : `${roundTenth(ratio * 100).toFixed(1)}g`}</div>`;
  }

  function filteredFoods() {
    return state.foods
      .filter(food => food.name.toLocaleLowerCase("ja").includes(state.search.toLocaleLowerCase("ja")))
      .sort((a, b) => compareFoods(a, b, state.foodSort));
  }

  function updateFoodList() {
    const list = $(".food-list");
    if (!list) return;
    const filtered = filteredFoods();
    list.innerHTML = filtered.length ? filtered.map(foodCardMarkup).join("") : `<div class="empty">${state.foods.length ? "検索結果がありません。" : "食品マスターは空です。よく使う食品を登録しましょう。"}</div>`;
    app.querySelectorAll("[data-edit-food]").forEach(button => button.addEventListener("click", event => openFoodDialog(state.foods.find(food => food.id === button.dataset.editFood), clickedByKeyboard(event))));
  }

  const expandedPickerFoods = new Set();

  function foodPickerMatches() {
    const query = state.todayFoodSearch.toLocaleLowerCase("ja");
    return state.foods.filter(food => food.name.toLocaleLowerCase("ja").includes(query));
  }

  function renderFoodPickerList() {
    const list = $("#food-picker-list");
    const matches = foodPickerMatches();
    const selectedId = $('#add-meal-form input[name="foodId"]')?.value || "";
    list.innerHTML = matches.length ? matches.map((food, index) => {
      const selected = food.id === selectedId;
      const expanded = expandedPickerFoods.has(food.id);
      const id = escapeHtml(food.id);
      return `<article class="food-picker-item${selected ? " selected" : ""}${expanded ? " expanded" : ""}">
        <div class="food-picker-row">
          <button type="button" class="food-picker-option" data-pick-food="${id}" aria-pressed="${selected}"><span class="food-picker-name">${escapeHtml(food.name)}</span></button>
          <button type="button" class="food-picker-detail-toggle" data-toggle-food-detail="${id}" aria-expanded="${expanded}" aria-controls="food-picker-detail-${index}">栄養成分</button>
        </div>
        <div class="food-picker-detail" id="food-picker-detail-${index}" data-pick-food="${id}" ${expanded ? "" : "hidden"}>
          <div class="food-basis">${food.type === "unit" ? `${numberText(food.baseAmount, 2)} ${escapeHtml(food.unit)}あたり` : "100gあたり"}</div>
          <div class="food-nutrients">
            <span class="nutrition-calorie"><small>カロリー</small><strong>${nutrientText(food.calories)} kcal</strong></span>
            <span class="nutrition-protein"><small>タンパク質</small><strong>${nutrientText(food.protein)} g</strong></span>
            <span class="nutrition-fat"><small>脂質</small><strong>${nutrientText(food.fat || 0)} g</strong></span>
            <span class="nutrition-carbohydrate"><small>炭水化物</small><strong>${nutrientText(food.carbohydrate || 0)} g</strong></span>
          </div>
        </div>
      </article>`;
    }).join("") : `<div class="empty">${state.foods.length ? "一致する食品がありません。" : "食品マスターに登録してください。"}</div>`;
    list.scrollTop = 0;
    $("#food-picker-count").textContent = state.todayFoodSearch ? `${matches.length}件／全${state.foods.length}件` : `全${state.foods.length}件`;
  }

  // 検索・選択のシート（#food-picker-dialog・#seibun-dialog）の大きさを visualViewport に合わせる。
  // スマートフォン幅ではシートは画面全体（--picker-layout）を覆い、動かさない。検索欄はシートの上にあるので
  // キーボードを出しても隠れない。キーボードに隠れる一覧の下の部分（--picker-list-pad）だけ一覧の末尾に余白を足し、
  // 一覧の最後の項目までスクロールで見られるようにする
  function fitSheet(dialog) {
    const viewport = window.visualViewport;
    if (!dialog.open || !viewport) return;
    dialog.style.setProperty("--picker-viewport", `${viewport.height}px`);
    dialog.style.setProperty("--picker-layout", `${window.innerHeight}px`);
    const list = dialog.querySelector(".food-picker-list");
    const hidden = Math.max(0, Math.round(list.getBoundingClientRect().bottom - (viewport.offsetTop + viewport.height)));
    dialog.style.setProperty("--picker-list-pad", `${hidden}px`);
    dialog.toggleAttribute("data-keyboard", hidden > 0);
  }

  // 下からのシートを開いている間、後ろのページと下に開いているダイアログをスクロールさせない（スマートフォン幅のみ）。
  // iOS Safari は overflow: hidden だけでは止まらないため、body を固定してスクロール位置を保存し、閉じたら戻す
  let sheetScrollLock = null;
  function lockSheetScroll() {
    if (sheetScrollLock || !matchMedia("(max-width: 600px)").matches) return;
    const body = document.body;
    const dialogs = [...document.querySelectorAll("dialog.modal[open]:not(.food-picker)")]
      .map(dialog => ({ dialog, scrollTop: dialog.scrollTop, overflow: dialog.style.overflow }));
    sheetScrollLock = { x: window.scrollX, y: window.scrollY, bodyStyle: body.getAttribute("style"), dialogs };
    dialogs.forEach(({ dialog }) => { dialog.style.overflow = "hidden"; });
    Object.assign(body.style, { position: "fixed", top: `${-sheetScrollLock.y}px`, left: "0", right: "0", width: "100%", overflow: "hidden" });
  }

  function unlockSheetScroll() {
    const lock = sheetScrollLock;
    if (!lock) return;
    sheetScrollLock = null;
    if (lock.bodyStyle === null) document.body.removeAttribute("style");
    else document.body.setAttribute("style", lock.bodyStyle);
    lock.dialogs.forEach(({ dialog, scrollTop, overflow }) => { dialog.style.overflow = overflow; dialog.scrollTop = scrollTop; });
    window.scrollTo(lock.x, lock.y);
  }

  function fitFoodPicker() {
    fitSheet($("#food-picker-dialog"));
  }

  function openFoodPicker() {
    if (!state.foods.length) return;
    const dialog = $("#food-picker-dialog");
    const search = $("#food-picker-search");
    state.todayFoodSearch = "";
    search.value = "";
    expandedPickerFoods.clear();
    renderFoodPickerList();
    lockSheetScroll();
    dialog.showModal();
    fitFoodPicker();
    // PCは検索欄にフォーカス。タッチ端末はキーボードで一覧が隠れないよう一覧にフォーカスする
    if (matchMedia("(hover: hover) and (pointer: fine)").matches) search.focus({ preventScroll: true });
    else $("#food-picker-list").focus({ preventScroll: true });
    scrollFoodPickerToSelected();
  }

  // 表示後に位置を決める（閉じている間は非表示でスクロール位置を設定できないため）。
  // 選択中の食品があれば一番上に、なければ先頭へ。末尾付近で上まで来ない場合はブラウザーが最下部で止める
  function scrollFoodPickerToSelected() {
    const list = $("#food-picker-list");
    const selected = list.querySelector(".food-picker-item.selected");
    list.scrollTop = selected ? selected.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop - 2 : 0;
  }

  // 最後の操作がキーボードかどうか（検索・選択のシートを閉じたあとのフォーカスの扱いに使う）
  let keyboardInput = false;

  // 検索・選択のシートを閉じる。タップなどで閉じるときは、先にシート内のフォーカス（検索欄など）を外す
  function closeSheet(dialog) {
    if (!keyboardInput && dialog.contains(document.activeElement)) document.activeElement.blur();
    dialog.close();
  }

  function chooseFood(foodId) {
    const food = state.foods.find(item => item.id === foodId);
    const form = $("#add-meal-form");
    if (!food || !form) return;
    form.elements.foodId.value = food.id;
    const trigger = $("#food-picker-open");
    trigger.classList.add("has-value");
    trigger.querySelector(".food-picker-trigger-text").textContent = food.name;
    updateAmountLabel(food.id);
    closeSheet($("#food-picker-dialog"));
  }

  function updateFoodPickerSearch(event) {
    state.todayFoodSearch = event.target.value.slice(0, 50); // 検索語は50文字まで（maxlength と同じ）
    renderFoodPickerList();
  }

  // ===== 成分表から探す（seibun.json：tools/convert_seibun.py で生成） =====
  // seibun.json は初めて開いたときに読み、この変数だけに持つ（state や IndexedDB には入れない）
  const SEIBUN_LIMIT = 100;
  let seibunData = null;
  let seibunLoading = null;
  let seibunTarget = "";
  const expandedSeibunFoods = new Set();

  // tools/convert_seibun.py の normalize() と同じ処理（ルールはスクリプト冒頭のコメントが正本）
  function normalizeSeibun(s) {
    s = s.normalize("NFKC").toLowerCase();
    s = s.replace(/[ァ-ヶヽヾ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
    return s.replace(/[\s()\[\]{}<>・:;,.、。「」『』【】〔〕〈〉《》!?"'`\/\\|~〜_\-=+*#&^$@…‥]/g, "");
  }

  // 一覧と名前欄には分かりやすい名前（label：tools/seibun_labels.json）を使う。label がない食品は正式名
  function seibunLabel(food) {
    return String(food.label || food.name);
  }

  function loadSeibun() {
    if (seibunData) return Promise.resolve(seibunData);
    if (!seibunLoading) {
      seibunLoading = fetch("./seibun.json").then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      }).then(data => {
        if (!data || !Array.isArray(data.foods) || !Array.isArray(data.terms)) throw new Error("seibun.json の形式が正しくありません");
        const foods = data.foods.map(food => ({ ...food, label: seibunLabel(food), name: String(food.name) }));
        seibunData = {
          source: String(data.source || ""), updated: String(data.updated || ""), foods,
          byCode: new Map(foods.map(food => [food.code, food])),
          terms: new Set(data.terms), maxTermLength: data.terms.reduce((max, term) => Math.max(max, [...term].length), 1)
        };
        return seibunPrepare(seibunData);
      }).finally(() => { seibunLoading = null; });
    }
    return seibunLoading;
  }

  // 正規化した語を terms で区切る。先頭からの最長一致で決め打ちせず、区切り方全体を比べて
  // ① terms にない（区切れずに残る）文字が少ない → ② 区切った語の数が少ない → ③ 同じなら先頭から長い語を取るもの（今までの最長一致に近いもの）
  // を選ぶ（動的計画法）。区切れずに残る文字は、続いていれば1つの語にまとめる（例：「ぎゅうひれ」→「ぎゅう／ひれ」）。
  // tools/convert_seibun.py の segment() と同じ処理
  function seibunSegment(text) {
    const chars = [...text];
    const n = chars.length;
    // best[i][s]：i 文字目から後ろの最良の区切り方。s = 1 は直前が区切れずに残った文字（続けて残ると1つの語にまとまる）
    const best = Array.from({ length: n + 1 }, () => [null, null]);
    best[n][0] = best[n][1] = { left: 0, count: 0 };
    for (let i = n - 1; i >= 0; i--) {
      for (const afterLeft of [0, 1]) {
        let choice = null;
        const consider = (len, left, count, nextState) => {
          const rest = best[i + Math.max(len, 1)][nextState];
          const candidate = { len, left: left + rest.left, count: count + rest.count, nextState };
          if (!choice || candidate.left < choice.left || (candidate.left === choice.left && candidate.count < choice.count)) choice = candidate;
        };
        for (let len = Math.min(seibunData.maxTermLength, n - i); len > 0; len--) {
          if (seibunData.terms.has(chars.slice(i, i + len).join(""))) consider(len, 0, 1, 0);
        }
        consider(0, 1, afterLeft ? 0 : 1, 1); // len 0 は区切れずに残る1文字
        best[i][afterLeft] = choice;
      }
    }
    const parts = [];
    let pending = "";
    for (let i = 0, state = 0; i < n;) {
      const choice = best[i][state];
      if (choice.len) {
        if (pending) { parts.push(pending); pending = ""; }
        parts.push(chars.slice(i, i + choice.len).join(""));
        i += choice.len;
      } else {
        pending += chars[i];
        i += 1;
      }
      state = choice.nextState;
    }
    if (pending) parts.push(pending);
    return parts;
  }

  // 検索語を空白で分けて正規化し、それぞれを terms で区切る（seibunSegment）。区切れない文字はつなげて1つの条件にする
  function seibunQueryParts(query) {
    const parts = [];
    for (const word of query.split(/\s+/)) parts.push(...seibunSegment(normalizeSeibun(word)));
    return [...new Set(parts)];
  }

  // 語を、その語より短い terms だけで先頭から最長一致で区切る（「胸肉」→「胸／肉」）。terms で覆いきれなければ null
  function seibunSubParts(part) {
    if (seibunData.subParts.has(part)) return seibunData.subParts.get(part);
    const chars = [...part];
    const max = Math.min(seibunData.maxTermLength, chars.length - 1);
    let pieces = [];
    let i = 0;
    while (i < chars.length) {
      let hit = "";
      for (let n = Math.min(max, chars.length - i); n > 0; n--) {
        const piece = chars.slice(i, i + n).join("");
        if (seibunData.terms.has(piece)) { hit = piece; break; }
      }
      if (!hit) { pieces = null; break; }
      pieces.push(hit);
      i += [...hit].length;
    }
    seibunData.subParts.set(part, pieces);
    return pieces;
  }

  // 区切った語が当たったか：search がそのまま含む、または terms でさらに細かく区切ったすべての部分が当たる（再帰）
  function seibunPartHits(search, part) {
    if (search.includes(part)) return true;
    const pieces = seibunSubParts(part);
    return Boolean(pieces) && pieces.every(piece => seibunPartHits(search, piece));
  }

  // 区切った語がすべて当たった食品。並びは
  // ① labelKeys（label の正規化と漢字の別の書き方）のどれかが検索語全体で始まる → ② どれかに検索語全体を含む → ③ それ以外、
  // 同じグループ内は 単語の先頭で一致した語が多い順 → 食品番号順（成分表は主な部位・生が先に並ぶため）
  function seibunMatches(query) {
    const parts = seibunQueryParts(query);
    if (!parts.length) return [];
    const whole = normalizeSeibun(query);
    const results = [];
    for (const food of seibunData.foods) {
      if (!parts.every(part => seibunPartHits(food.search, part))) continue;
      const headHits = parts.filter(part => food.search.startsWith(part) || food.search.includes(` ${part}`)).length;
      const group = food.labelKeys.some(key => key.startsWith(whole)) ? 0 : food.labelKeys.some(key => key.includes(whole)) ? 1 : 2;
      results.push({ food, headHits, group });
    }
    results.sort((a, b) => a.group - b.group || b.headHits - a.headHits || (a.food.code < b.food.code ? -1 : a.food.code > b.food.code ? 1 : 0));
    return results.map(result => result.food);
  }

  // 読み込んだデータに、並び替え用の labelKeys（なければ label の正規化）と、細かく区切った結果のキャッシュを足す
  function seibunPrepare(data) {
    data.foods.forEach(food => {
      food.labelKeys = Array.isArray(food.labelKeys) && food.labelKeys.length ? food.labelKeys.map(String) : [normalizeSeibun(food.label)];
    });
    data.subParts = new Map();
    return data;
  }

  function seibunDateText(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    return match ? `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日` : value;
  }

  function renderSeibunList() {
    const list = $("#seibun-list");
    const query = $("#seibun-search").value.slice(0, 50); // 検索語は50文字まで（maxlength と同じ）
    const total = seibunData.foods.length;
    const matches = query.trim() ? seibunMatches(query) : [];
    list.innerHTML = matches.length ? matches.slice(0, SEIBUN_LIMIT).map((food, index) => {
      const code = escapeHtml(food.code);
      const expanded = expandedSeibunFoods.has(food.code);
      return `<article class="food-picker-item${expanded ? " expanded" : ""}">
        <div class="food-picker-row">
          <button type="button" class="food-picker-option" data-pick-seibun="${code}"><span class="food-picker-name">${escapeHtml(food.label)}</span>${food.estimated ? '<span class="seibun-estimated">推計値を含む</span>' : ""}</button>
          <button type="button" class="food-picker-detail-toggle" data-toggle-seibun-detail="${code}" aria-expanded="${expanded}" aria-controls="seibun-detail-${index}">栄養成分</button>
        </div>
        <div class="food-picker-detail" id="seibun-detail-${index}" data-pick-seibun="${code}" ${expanded ? "" : "hidden"}>
          <div class="seibun-official">成分表の食品名：${escapeHtml(food.name)}</div>
          <div class="food-basis">100gあたり</div>
          <div class="food-nutrients">
            <span class="nutrition-calorie"><small>カロリー</small><strong>${nutrientText(food.calories)} kcal</strong></span>
            <span class="nutrition-protein"><small>タンパク質</small><strong>${nutrientText(food.protein)} g</strong></span>
            <span class="nutrition-fat"><small>脂質</small><strong>${nutrientText(food.fat)} g</strong></span>
            <span class="nutrition-carbohydrate"><small>炭水化物</small><strong>${nutrientText(food.carbohydrate)} g</strong></span>
          </div>
        </div>
      </article>`;
    }).join("") : `<div class="empty">${query.trim() ? "一致する食品がありません。" : "食品名を入力してください。"}</div>`;
    list.scrollTop = 0;
    $("#seibun-count").textContent = query.trim()
      ? `${matches.length}件${matches.length > SEIBUN_LIMIT ? `（上位${SEIBUN_LIMIT}件を表示）` : ""}／全${total}件`
      : `全${total}件`;
  }

  function fitSeibunPicker() {
    fitSheet($("#seibun-dialog"));
  }

  async function openSeibunDialog(target) {
    if (target === "food") {
      // 保存済みの固定商品を100gあたりの値にすると、保存時に過去の記録の個数がgとして再計算されるため置き換えない
      const previous = state.foods.find(item => item.id === $("#food-form").elements.id.value);
      if (previous && previous.type === "unit") return showToast("個数で記録する食品は、成分表の値（100gあたり）に置き換えられません。", true);
    }
    if (seibunLoading) return;
    try {
      await loadSeibun();
    } catch (error) {
      console.error("成分表データを読み込めませんでした:", error);
      return showToast("成分表データを読み込めませんでした。", true);
    }
    seibunTarget = target;
    const dialog = $("#seibun-dialog");
    const search = $("#seibun-search");
    search.value = "";
    expandedSeibunFoods.clear();
    $("#seibun-source").textContent = `出典：${seibunData.source}（更新日 ${seibunDateText(seibunData.updated)}）`;
    renderSeibunList();
    lockSheetScroll();
    dialog.showModal();
    fitSeibunPicker();
    search.focus({ preventScroll: true });
  }

  // 選んだ食品の値を元のダイアログに入れる（保存は既存の処理のまま。名前・数値は保存前に編集できる）
  function chooseSeibunFood(code) {
    const food = seibunData?.byCode.get(code);
    if (!food) return;
    const isQuick = seibunTarget === "quick";
    const form = $(isQuick ? "#quick-food-form" : "#food-form");
    // 既存の食品・今日限りの記録の編集では名前を変えない
    const editing = Boolean(isQuick ? form.elements.mealId.value : form.elements.id.value);
    if (!editing) form.elements.name.value = food.label;
    form.elements.type.value = "weight";
    if (isQuick) updateQuickFoodFields();
    else updateFoodFields();
    form.elements.calories.value = String(food.calories);
    form.elements.protein.value = String(food.protein);
    form.elements.fat.value = String(food.fat);
    form.elements.carbohydrate.value = String(food.carbohydrate);
    if (!isQuick) updateFoodDuplicateNote();
    closeSheet($("#seibun-dialog"));
  }

  function renderFoods() {
    const filtered = filteredFoods();
    app.innerHTML = `<div class="page">
      <section class="card foods-card"><div class="meal-top"><h2>食品マスター</h2><button id="new-food" class="button primary small" type="button">＋ 食品を登録</button></div>
      <label class="field">食品名で検索<input id="food-search" class="search" type="search" maxlength="50" value="${escapeHtml(state.search)}" placeholder="例：鶏むね肉"></label>
      <label class="field">並び替え<select id="food-sort">${FOOD_SORT_OPTIONS.map(([value, label]) =>
        `<option value="${value}"${state.foodSort === value ? " selected" : ""}>${label}</option>`).join("")}</select></label>
      <div class="food-list">${filtered.length ? filtered.map(foodCardMarkup).join("") : `<div class="empty">${state.foods.length ? "検索結果がありません。" : "食品マスターは空です。よく使う食品を登録しましょう。"}</div>`}</div></section>
      </div>`;
    $("#new-food").addEventListener("click", event => openFoodDialog(null, clickedByKeyboard(event)));
    const foodSearch = $("#food-search");
    foodSearch.addEventListener("compositionstart", () => { state.composingSearch = true; });
    foodSearch.addEventListener("compositionend", event => {
      state.composingSearch = false;
      state.search = event.target.value.slice(0, 50);
      updateFoodList();
    });
    foodSearch.addEventListener("input", event => {
      state.search = event.target.value.slice(0, 50);
      if (!state.composingSearch) updateFoodList();
    });
    $("#food-sort").addEventListener("change", event => { state.foodSort = event.target.value; renderFoods(); });
    app.querySelectorAll("[data-edit-food]").forEach(button => button.addEventListener("click", event => openFoodDialog(state.foods.find(food => food.id === button.dataset.editFood), clickedByKeyboard(event))));
  }

  // 食品マスターの並び替えの選択肢（どの栄養素も「多い順 → 少ない順」）
  const FOOD_SORT_OPTIONS = [
    ["name", "名前順"],
    ["protein-desc", "タンパク質が多い順"], ["protein-asc", "タンパク質が少ない順"],
    ["fat-desc", "脂質が多い順"], ["fat-asc", "脂質が少ない順"],
    ["carbohydrate-desc", "炭水化物が多い順"], ["carbohydrate-asc", "炭水化物が少ない順"]
  ];

  // 名前順は五十音順。栄養素の順は1kcalあたりの量（カロリーが0の食品は0として扱う）、同じなら五十音順
  function compareFoods(a, b, sort) {
    const { nutrient, direction } = foodSortParts(sort);
    if (!nutrient) return a.name.localeCompare(b.name, "ja");
    const aRatio = foodNutrientRatio(a, nutrient) ?? 0;
    const bRatio = foodNutrientRatio(b, nutrient) ?? 0;
    const result = aRatio - bRatio;
    if (result !== 0) return direction === "desc" ? -result : result;
    return a.name.localeCompare(b.name, "ja");
  }

  function openCopyDialog(event) {
    const form = $("#copy-form");
    form.reset();
    form.elements.sourceDate.value = "";
    $("#copy-target").textContent = `コピー先：${state.date}`;
    $("#copy-preview").textContent = "コピー元の日付を選択してください。";
    showFormDialog($("#copy-dialog"), clickedByKeyboard(event));
  }

  function updateCopyPreview() {
    const sourceDate = $("#copy-form").elements.sourceDate.value;
    const meals = mealsFor(sourceDate);
    const preview = $("#copy-preview");
    if (!isValidDate(sourceDate)) {
      preview.textContent = "コピー元の日付を選択してください。";
    } else if (!meals.length) {
      preview.textContent = "この日にはコピーできる食事記録がありません。";
    } else {
      preview.innerHTML = meals.map(meal => `<div>${escapeHtml(meal.foodName)} — ${numberText(meal.amount, 3)} ${escapeHtml(meal.unit)}（${nutrientText(meal.calories)} kcal）</div>`).join("");
    }
  }

  async function copyMeals(event) {
    event.preventDefault();
    const sourceDate = event.currentTarget.elements.sourceDate.value;
    const mode = event.currentTarget.elements.mode.value;
    const source = mealsFor(sourceDate);
    if (!isValidDate(sourceDate) || sourceDate === state.date || !source.length) return showToast("別の日付の食事記録がある日を選択してください。", true);
    if (mode === "replace" && mealsFor(state.date).length && !confirm(`${state.date}の既存の食事記録を置き換えます。よろしいですか？`)) return;
    const sourceTotal = source.reduce((sum, meal) => ({
      calories: sum.calories + meal.calories, protein: sum.protein + (meal.protein || 0),
      fat: sum.fat + (meal.fat || 0), carbohydrate: sum.carbohydrate + (meal.carbohydrate || 0)
    }), { calories: 0, protein: 0, fat: 0, carbohydrate: 0 });
    const destinationTotal = mode === "replace" ? { calories: 0, protein: 0, fat: 0, carbohydrate: 0 } : totalsFor(state.date);
    const afterCopy = {};
    for (const [key] of NUTRIENT_FIELDS) afterCopy[key] = sourceTotal[key] + (destinationTotal[key] || 0);
    if (source.some(meal => !withinNutritionLimits(meal))) {
      return showToast(`コピー元に、1件の栄養値が上限（${NUTRITION_LIMIT_TEXT}）を超える記録があります。`, true);
    }
    if (!withinNutritionLimits(afterCopy, true)) {
      return showToast(`コピー後の1日の合計が上限（${DAY_LIMIT_TEXT}）を超えます。`, true);
    }
    const copies = source.map(meal => ({ ...meal, id: makeId(), date: state.date, createdAt: Date.now() }));
    const db = await database();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("meals", "readwrite");
        const store = transaction.objectStore("meals");
        if (mode === "replace") mealsFor(state.date).forEach(meal => store.delete(meal.id));
        copies.forEach(meal => store.put(meal));
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("食事のコピーに失敗しました。"));
        transaction.onabort = () => reject(transaction.error || new Error("食事のコピーが取り消されました。"));
      });
      await refreshData();
      $("#copy-dialog").close();
      render();
      showToast(`食事${copies.length}件をコピーしました。`);
    } catch (error) { showToast(error.message, true); }
  }

  function recordedDates() {
    return [...new Set([...state.meals.map(meal => meal.date), ...state.weights.map(weight => weight.date)])].sort((a, b) => b.localeCompare(a));
  }

  function recordedMonths() {
    return [...new Set(recordedDates().map(date => date.slice(0, 7)))].sort((a, b) => b.localeCompare(a));
  }

  function monthLabel(month) {
    const [year, value] = month.split("-");
    return `${year}年${Number(value)}月`;
  }

  // グラフの期間の設定を { chartRangeMode: "auto" / "manual", chartStart, chartEnd } にそろえる（古いデータ・バックアップの読み替えも含む）。
  // v86以前の chartRangeMode の形はそのまま読む。v87 の chartPeriod の形は、"custom" → その日付を選んだ期間、
  // "goal" → いつから＝最初の記録の日・いつまで＝達成目標日、それ以外 → 設定なし（最初の記録〜最新の記録）として読む
  function normalizeChartSettings(settings, firstDate) {
    const manual = (start, end) => isValidDate(start) && isValidDate(end) && start <= end
      ? { chartRangeMode: "manual", chartStart: start, chartEnd: end } : { chartRangeMode: "auto", chartStart: "", chartEnd: "" };
    if (LEGACY_CHART_PERIODS.includes(settings.chartPeriod)) {
      if (settings.chartPeriod === "custom") return manual(settings.chartStart, settings.chartEnd);
      if (settings.chartPeriod === "goal") return manual(firstDate, settings.targetDate);
      return manual("", "");
    }
    return settings.chartRangeMode === "manual" ? manual(settings.chartStart, settings.chartEnd) : manual("", "");
  }

  function weightDates() {
    return [...new Set(state.weights.map(weight => weight.date).filter(isValidDate))].sort();
  }

  // グラフの期間：選んだ期間（正しい日付で、いつから ≦ いつまで）が使えればそれ（v87 の「指定」のように記録がない日でもそのまま使う）、
  // 使えないとき（設定なし・保存されている日付が使えない）は最初の記録の日〜最新の記録の日
  function chartRange() {
    const { chartStart, chartEnd, chartRangeMode } = state.settings;
    const dates = weightDates();
    if (chartRangeMode === "manual" && isValidDate(chartStart) && isValidDate(chartEnd) && chartStart <= chartEnd) {
      return { start: chartStart, end: chartEnd };
    }
    return dates.length ? { start: dates[0], end: dates.at(-1) } : { start: "", end: "" };
  }

  // 「いつから」「いつまで」で選べる日付。いつから＝記録がある日を古い順（いつまでより後は出さない）、
  // いつまで＝記録がある日を新しい順（いつからより前・達成目標日と同じ日は出さない）。今の期間の日付に記録がないとき（v87 の「指定」など）もその日を入れる
  function chartChoiceDates(which, range) {
    const dates = weightDates();
    const withDate = (list, date) => isValidDate(date) && !list.includes(date) ? [...list, date].sort() : list;
    if (which === "start") return withDate(dates, range.start).filter(date => !range.end || date <= range.end);
    return withDate(dates, range.end).filter(date => (!range.start || date >= range.start) && date !== state.settings.targetDate).reverse();
  }

  // 「いつまで」のいちばん上の「達成目標日」を出せるか（達成目標日があり、いつから以降）
  function chartTargetChoice(range) {
    const target = state.settings.targetDate;
    return isValidDate(target) && (!range.start || target >= range.start);
  }

  // 日付の一覧のシート（#date-sheet）を開く。年月ごとにたためる（初めは全部たたむ。年月が1つだけ・選んでいる日付の年月は開く）。
  // 開き方・フォーカス・スクロールの止め方は「⋯」のメニューと同じ（指・マウスで開いたら dialog 自体、キーボードなら最初の操作できる要素）
  function openDateSheet(which, viaKeyboard = false) {
    const range = chartRange();
    const selected = which === "start" ? range.start : range.end;
    const dates = chartChoiceDates(which, range);
    const groups = [];
    for (const date of dates) {
      const month = date.slice(0, 7);
      if (!groups.length || groups.at(-1).month !== month) groups.push({ month, dates: [] });
      groups.at(-1).dates.push(date);
    }
    const check = on => `<span class="date-sheet-check" aria-hidden="true">${on ? "✓" : ""}</span>`;
    const target = which === "end" && chartTargetChoice(range)
      ? `<button type="button" class="date-sheet-day date-sheet-target" data-sheet-date="${state.settings.targetDate}" aria-pressed="${selected === state.settings.targetDate}">達成目標日${check(selected === state.settings.targetDate)}</button>` : "";
    const list = groups.map(group => {
      const open = groups.length === 1 || group.dates.includes(selected);
      const id = `date-sheet-${group.month}`;
      return `<div class="date-sheet-group"><button type="button" class="date-sheet-month" aria-expanded="${open}" aria-controls="${id}">${monthLabel(group.month)}<span class="date-sheet-chevron" aria-hidden="true"></span></button>` +
        `<div class="date-sheet-days" id="${id}"${open ? "" : " hidden"}>${group.dates.map(date =>
          `<button type="button" class="date-sheet-day" data-sheet-date="${date}" aria-pressed="${date === selected}">${dateLabel(date)}${check(date === selected)}</button>`).join("")}</div></div>`;
    }).join("");
    const dialog = $("#date-sheet");
    dialog.dataset.which = which;
    $("#date-sheet-title").textContent = which === "start" ? "いつから" : "いつまで";
    $("#date-sheet-list").innerHTML = target + list;
    $("#date-sheet-list").scrollTop = 0;
    lockSheetScroll();
    showFormDialog(dialog, viaKeyboard);
    sizeDateSheet();
    scrollDateSheetToSelected();
  }

  // 選んでいる日付の行が一覧（#date-sheet-list）のいちばん上に来るようにスクロールする。
  // 下に行が足りないときは、ブラウザーがスクロールできる最大値に丸めるので、その日が見える一番下までのスクロールになる
  // 対象は年月の中の行だけ（「達成目標日」の行はもともと一番上）。開くときの1回だけで、年月の開閉・resize では直さない
  function scrollDateSheetToSelected() {
    const list = $("#date-sheet-list");
    const row = list.querySelector('.date-sheet-days [aria-pressed="true"]');
    list.scrollTop = 0;
    if (!row) return;
    list.scrollTop = row.getBoundingClientRect().top - list.getBoundingClientRect().top;
  }

  // シートの高さは開いている間は固定する：全部の年月を開いた状態の中身の高さ（開くときに1回だけ測る）。上限は画面の高さの75%（JSで測った
  // window.innerHeight を使う。dvh がない古い iOS でも同じ）。年月を閉じて中身が減ったときは、シートの下に余白として残す（縮めない）
  const DATE_SHEET_MAX_RATIO = 0.75;
  function sizeDateSheet() {
    const inner = $(".date-sheet-inner");
    const folded = [...$("#date-sheet-list").querySelectorAll(".date-sheet-days[hidden]")];
    inner.style.height = "";
    inner.style.maxHeight = "none";
    folded.forEach(days => { days.hidden = false; });
    inner.dataset.fullHeight = String(Math.ceil(inner.getBoundingClientRect().height));
    folded.forEach(days => { days.hidden = true; });
    applyDateSheetHeight();
  }
  // 上限（画面の高さの75%）を当てはめる。画面の回転などで画面の高さが変わったときも、これで上限だけ計算し直す
  function applyDateSheetHeight() {
    const inner = $(".date-sheet-inner");
    const full = Number(inner.dataset.fullHeight) || 0;
    inner.style.maxHeight = "none";
    inner.style.height = `${Math.min(full, Math.floor(window.innerHeight * DATE_SHEET_MAX_RATIO))}px`;
  }

  function closeDateSheet() {
    const dialog = $("#date-sheet");
    if (dialog.open) dialog.close();
    unlockSheetScroll();
  }

  // 一覧で日付（または「達成目標日」）を選んだら、シートを閉じて、その期間を保存して描き直す（いつから ≦ いつまで のときだけ）
  async function applyChartDate(which, date) {
    closeDateSheet();
    const range = chartRange();
    const start = which === "start" ? date : range.start;
    const end = which === "end" ? date : range.end;
    if (!isValidDate(start) || !isValidDate(end) || start > end) {
      return showToast("「いつから」は「いつまで」以前の日付にしてください。", true);
    }
    try {
      await saveSettings({ ...state.settings, chartRangeMode: "manual", chartStart: start, chartEnd: end });
      render();
    } catch (error) { showToast(error.message, true); }
  }

  // 目標の1行の日付：今年なら「3/31」、別の年なら「2027/3/31」
  function goalDateText(date) {
    const [year, month, day] = date.split("-");
    return `${year === localDate().slice(0, 4) ? "" : `${year}/`}${Number(month)}/${Number(day)}`;
  }

  // 記録のページの見出し：どの日も「2026/11/14(土)の記録」（今年でも年を付ける）。今日のときは、画面の側で後ろに小さく「今日」を添える
  function dayHeading(date) {
    return `${dateLabel(date)}の記録`;
  }

  function dateLabel(date) {
    if (!isValidDate(date)) return date;
    const weekday = new Date(`${date}T00:00:00`).toLocaleDateString("ja-JP", { weekday: "short" });
    return `${date.replace(/-/g, "/")}(${weekday})`;
  }

  function renderHistory() {
    const dates = recordedDates();
    const months = recordedMonths();
    if (!months.includes(state.historyMonth)) state.historyMonth = months[0] || "";
    const visibleDates = dates.filter(date => date.startsWith(state.historyMonth));
    const monthText = state.historyMonth ? monthLabel(state.historyMonth) : "";
    const range = chartRange();
    const targetDate = state.settings.targetDate;
    // 「いつから」「いつまで」の欄（選択欄と同じ見た目の button。押すと日付の一覧のシート）。いつまでが達成目標日なら「達成目標日」と出す
    const hasRange = isValidDate(range.start) && isValidDate(range.end);
    const startText = hasRange ? dateLabel(range.start) : "記録なし";
    const endText = !hasRange ? "記録なし" : isValidDate(targetDate) && range.end === targetDate ? "達成目標日" : dateLabel(range.end);
    const goalWeight = state.settings.goalWeight;
    app.innerHTML = `<div class="page">
      <section class="card chart-card">
        <div class="meal-top"><h2>体重の推移</h2></div>
        <div class="goal-row">
          <div class="goal-cell"><span class="goal-label">目標</span>${goalWeight !== null ? `<strong class="goal-value">${kgText(goalWeight)} kg</strong>` : `<span class="goal-value goal-unset">未設定</span>`}</div>
          <div class="goal-cell"><span class="goal-label">達成目標日</span>${goalWeight !== null && isValidDate(targetDate) ? `<strong class="goal-value">${goalDateText(targetDate)}</strong>` : `<span class="goal-value goal-unset">未設定</span>`}</div>
          <button id="open-goal" class="button secondary small" type="button">${goalWeight !== null ? "変更" : "設定"}</button>
        </div>
        <div class="chart-range">
          <div class="field"><span id="chart-start-label">いつから</span><button type="button" id="chart-start" class="chart-date-button" data-chart-date="start" aria-haspopup="dialog" aria-labelledby="chart-start-label chart-start"${hasRange ? "" : " disabled"}><span class="chart-date-text">${startText}</span></button></div>
          <div class="field"><span id="chart-end-label">いつまで</span><button type="button" id="chart-end" class="chart-date-button" data-chart-date="end" aria-haspopup="dialog" aria-labelledby="chart-end-label chart-end"${hasRange ? "" : " disabled"}><span class="chart-date-text">${endText}</span></button></div>
        </div>
        <div id="chart-stats" class="chart-stats"></div>
        <div id="weight-chart" class="weight-chart"></div>
        <div id="chart-legend" class="chart-legend"></div>
        <p class="chart-caption">期間内の記録をすべて表示します。記録のない日は補完しません。先週比は、直近7日間と、その前の7日間の体重の平均の差です。</p>
      </section>
      <section class="card history-card">
        <div class="history-heading">
          <div><h2>記録一覧</h2></div>
          <div class="history-total"><span>全体</span><strong>${dates.length}</strong><span>日分</span></div>
        </div>
        <div class="history-month-heading">
          <div><h2>${months.length ? escapeHtml(monthText) : "記録なし"}</h2><p>${visibleDates.length}日分</p></div>
        </div>
        ${months.length ? `<div class="history-months" role="tablist" aria-label="記録の年月">${months.map(month =>
          `<button type="button" class="month-tab${month === state.historyMonth ? " active" : ""}" data-history-month="${month}" role="tab" aria-selected="${month === state.historyMonth}">${monthLabel(month)}</button>`
        ).join("")}</div>
        ` : ""}
      <div class="history-list">${visibleDates.length ? visibleDates.map(date => {
        const total = totalsFor(date);
        const hasMeals = mealsFor(date).length > 0;
        const weight = state.weights.find(item => item.date === date);
        // 日付の行（›付き）が「その日を開く」button。体重・栄養成分・PFCは押しても何もしない。右上の「⋯」のメニューで削除。
        // 日付の button の読み上げ名は aria-labelledby で日付・体重・栄養成分・PFCを読む。Tab は日付の行→⋯
        const id = `history-${date}`;
        const parts = hasMeals ? [`${id}-date`, `${id}-weight`, `${id}-meals`, `${id}-pfc`] : [`${id}-date`, `${id}-weight`, `${id}-meals`];
        return `        <article class="history-row${hasMeals ? "" : " no-meals"}">
          <button type="button" class="history-open" data-open-date="${date}" aria-labelledby="${parts.join(" ")}"><span class="history-date" id="${id}-date">${dateLabel(date)}</span><span class="history-chevron" aria-hidden="true"></span></button>
          <button type="button" class="more-button" data-history-menu="${date}" aria-haspopup="dialog" aria-label="${dateLabel(date)}の操作">⋯</button>
          <div class="history-body">
          <div class="history-weight${weight ? "" : " is-empty"}" id="${id}-weight">${weight ? `${kgText(weight.kg)} <span class="history-weight-unit">kg</span>` : "体重 未記録"}</div>
          ${hasMeals ? `<div class="history-summary nutrient-grid" id="${id}-meals">
            <span class="nutrition-calorie">カロリー ${nutrientText(total.calories)} kcal</span>
            <span class="nutrition-protein">タンパク質 ${nutrientText(total.protein)} g</span>
            <span class="nutrition-fat">脂質 ${nutrientText(total.fat)} g</span>
            <span class="nutrition-carbohydrate">炭水化物 ${nutrientText(total.carbohydrate)} g</span>
          </div>
          <div class="history-pfc" id="${id}-pfc"><span class="nutrition-protein">P ${nutrientText(pfcPercentages(total).protein)}%</span><span class="nutrition-fat">F ${nutrientText(pfcPercentages(total).fat)}%</span><span class="nutrition-carbohydrate">C ${nutrientText(pfcPercentages(total).carbohydrate)}%</span></div>` : `<div class="history-summary history-no-meals" id="${id}-meals">食事 未記録</div>`}
          </div>
        </article>`;
      }).join("") : `<div class="empty">${months.length ? `${escapeHtml(monthText)}の記録はありません。` : "まだ記録がありません。"}</div>`}</div>
      ${months.length ? `<div class="history-actions">
        <button type="button" class="button danger small" id="delete-month-history">${escapeHtml(monthLabel(state.historyMonth))}の記録を削除</button>
        <button type="button" class="button danger small" id="delete-all-history">食事と体重の記録をすべて削除</button>
      </div>` : ""}
      </section>
      </div>`;
    $("#open-goal").addEventListener("click", event => openGoalDialog(clickedByKeyboard(event)));
    mountWeightChart(range, goalWeight);
    app.querySelectorAll("[data-chart-date]").forEach(button => button.addEventListener("click", event => openDateSheet(button.dataset.chartDate, clickedByKeyboard(event))));
    app.querySelectorAll("[data-history-month]").forEach(button => button.addEventListener("click", () => {
      state.historyMonth = button.dataset.historyMonth;
      render();
    }));
    app.querySelectorAll("[data-history-menu]").forEach(button => button.addEventListener("click", event => openHistoryMenu(button.dataset.historyMenu, event.detail === 0)));
    app.querySelectorAll("[data-open-date]").forEach(button => button.addEventListener("click", () => {
      state.date = button.dataset.openDate;
      state.page = "today";
      render();
    }));
    $("#delete-month-history")?.addEventListener("click", deleteHistoryMonth);
    $("#delete-all-history")?.addEventListener("click", deleteAllHistory);
  }

  // 履歴のカードの「⋯」のメニュー：削除だけ（日付を入れて確認してから、その日の食事と体重を消す）
  function openHistoryMenu(date, viaKeyboard = false) {
    const weight = state.weights.find(item => item.date === date);
    const hasMeals = mealsFor(date).length > 0;
    openActionSheet({
      title: dateLabel(date),
      detail: `${weight ? `${kgText(weight.kg)} kg` : "体重 未記録"} ・ ${hasMeals ? `${nutrientText(totalsFor(date).calories)} kcal` : "食事 未記録"}`,
      actions: [{ label: "削除", danger: true, run: () => deleteHistoryDate(date) }],
      viaKeyboard
    });
  }

  // その日の食事と体重の削除（ほかの記録も一緒に消えるので確認する）
  async function deleteHistoryDate(date) {
    if (!confirm(`${dateLabel(date)}の記録を削除しますか？\n食事と体重の記録が削除されます。`)) return;
    try {
      await deleteHistoryRecords([date]);
      await refreshData();
      render();
      showToast(`${dateLabel(date)}の記録を削除しました。`);
    } catch (error) { showToast(error.message, true); }
  }

  async function deleteHistoryMonth() {
    const dates = recordedDates().filter(date => date.startsWith(state.historyMonth));
    if (!dates.length) return;
    const label = monthLabel(state.historyMonth);
    if (!confirm(`${label}の記録（${dates.length}日分）を削除しますか？\n食事と体重の記録が削除されます。食品マスターと目標は残ります。`)) return;
    try {
      await deleteHistoryRecords(dates);
      await refreshData();
      render();
      showToast(`${label}の記録を削除しました。`);
    } catch (error) { showToast(error.message, true); }
  }

  async function deleteAllHistory() {
    const dates = recordedDates();
    if (!dates.length) return;
    if (!confirm(`食事と体重の記録（${dates.length}日分）をすべて削除しますか？\n食品マスターと目標は残ります。`)) return;
    try {
      await deleteHistoryRecords(dates);
      await refreshData();
      render();
      showToast("食事と体重の記録をすべて削除しました。");
    } catch (error) { showToast(error.message, true); }
  }

  // 目標のダイアログ（#goal-dialog）。今の目標を入れて開く。「目標をクリア」は目標があるときだけ
  function openGoalDialog(viaKeyboard = false) {
    const form = $("#goal-form");
    const { goalWeight, targetDate } = state.settings;
    form.reset();
    // value 属性（defaultValue）も保存済みの値にしておく（開いたあとは keepDateResetOnOpen が、ピッカーを開くたびにそのときの値にそろえる）
    form.elements.goalWeight.defaultValue = goalWeight === null ? "" : kgInputValue(goalWeight);
    form.elements.goalWeight.value = form.elements.goalWeight.defaultValue;
    form.elements.targetDate.defaultValue = targetDate || "";
    form.elements.targetDate.value = targetDate || "";
    updateClearTargetDate();
    $("#goal-dialog-title").textContent = goalWeight === null ? "目標を設定" : "目標を変更";
    $("#clear-goal").hidden = goalWeight === null;
    showFormDialog($("#goal-dialog"), viaKeyboard);
  }

  // iOS の日付ピッカーの「リセット」は、表示は「ピッカーを開いたときの日付」に戻すが、input の値は defaultValue（value 属性）に戻す。
  // ずれないよう、ピッカーを開くとき（focus・pointerdown）に defaultValue をそのときの値にそろえる（リセットの戻り先が表示も値も「開いたときの日付」になる）
  function keepDateResetOnOpen(input) {
    const sync = () => { input.defaultValue = input.value; };
    input.addEventListener("focus", sync);
    input.addEventListener("pointerdown", sync);
  }

  // 達成目標日の「消す」ボタンは、欄に日付が入っているときだけ出す
  function updateClearTargetDate() {
    $("#clear-target-date").hidden = !$("#goal-form").elements.targetDate.value;
  }

  async function saveGoal(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const weightValue = form.elements.goalWeight.value.trim();
    const dateValue = form.elements.targetDate.value;
    if (!weightValue && !dateValue) return clearGoal();
    const goalWeight = roundTenth(Number(weightValue));
    if (!weightValue || !Number.isFinite(goalWeight) || goalWeight <= 0 || goalWeight > 999.9 ||
        (dateValue && !isValidDate(dateValue))) {
      return showToast("目標体重は0.1〜999.9kg、達成目標日は2000/01/01〜2099/12/31の範囲で入力してください。", true);
    }
    try {
      await saveSettings({ ...state.settings, goalWeight, targetDate: dateValue });
      $("#goal-dialog").close();
      render();
      showToast("目標を保存しました。");
    } catch (error) { showToast(error.message, true); }
  }

  async function clearGoal() {
    try {
      await saveSettings({ ...state.settings, goalWeight: null, targetDate: "" });
      if ($("#goal-dialog").open) $("#goal-dialog").close();
      render();
      showToast("目標をクリアしました。");
    } catch (error) { showToast(error.message, true); }
  }

  function dateTimestamp(date) {
    return Date.parse(`${date}T00:00:00Z`);
  }

  // ===== 体重グラフ =====
  // 描く幅をグラフを入れる要素（#weight-chart）の実際の幅に合わせ、viewBox と表示の大きさを 1:1 にする（文字は 11px のまま、PC でも大きくならない）。
  // 幅が変わったら（画面の回転など）ResizeObserver で描き直す。素の SVG で描く
  const CHART_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];
  const CHART_DENSE_POINTS = 60; // これ以上の点は描かず線だけにする（タップで値を出す機能はそのまま）
  const CHART_LINE_COLOR = "var(--green-line)", CHART_DOT_COLOR = "var(--green)", CHART_GOAL_COLOR = "#a35e2d"; // 記録の線は点より薄い緑（緑は styles.css の変数。SVG では style で指定する）
  const CHART_PACE_DEFAULT = 0.5, CHART_PACE_MIN = 0.1, CHART_PACE_MAX = 1.0; // 先週比の色の基準のペース（kg/週）
  let chartState = null; // { range, goalWeight, observer, width, chart, selected }

  function addDays(date, days) {
    const [year, month, day] = date.split("-").map(Number);
    return localDate(new Date(year, month - 1, day + days)); // ローカルの日付で数える（UTC に変換しない）
  }

  function daysBetween(from, to) {
    return Math.round((dateTimestamp(to) - dateTimestamp(from)) / 86400000);
  }

  // 縦の目盛り：0.1・0.2・0.5・1・2・5・10 kg…から、4〜6本になる区切りのいい間隔を選び、上下の端もその倍数にそろえる（下は0未満にしない）
  function niceWeightScale(min, max) {
    const pad = Math.max((max - min) * .08, .05);
    const low = Math.max(0, min - pad), high = max + pad;
    let scale = null;
    for (const step of CHART_STEPS) {
      let lo = Math.max(0, Math.floor(low / step + 1e-9) * step);
      let hi = Math.ceil(high / step - 1e-9) * step;
      let count = Math.round((hi - lo) / step) + 1;
      while (count < 4) { // 本数が足りないときは上下に広げる（下は0まで）
        if (lo - step >= -1e-9 && count % 2 === 1) lo -= step; else hi += step;
        count += 1;
      }
      if (count <= 6) { scale = { step, lo: Math.max(0, lo), hi }; break; }
    }
    if (!scale) { const step = CHART_STEPS.at(-1); scale = { step, lo: Math.max(0, Math.floor(low / step) * step), hi: Math.ceil(high / step) * step }; }
    const ticks = [];
    for (let value = scale.lo; value <= scale.hi + scale.step / 2; value += scale.step) ticks.push(Math.round(value * 10) / 10);
    return { ...scale, ticks };
  }

  function chartTickText(value, step) {
    return step >= 1 ? Math.round(value).toLocaleString("ja-JP") : kgText(value);
  }

  function chartDateText(date) {
    const [, month, day] = date.split("-");
    return `${Number(month)}/${Number(day)}`;
  }

  function sortedWeights() {
    return state.weights.filter(item => isValidDate(item.date)).sort((a, b) => a.date.localeCompare(b.date));
  }

  function weightChartValues(range) {
    return state.weights
      .filter(item => item.date >= range.start && item.date <= range.end)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  // 目標の向き：保存されているすべての体重の記録のうち、いちばん古い日の体重と目標を比べる（表示している期間には関係しない）。
  // 古い体重 > 目標なら減量（"down"）、< 目標なら増量（"up"）、同じなら "same"。目標がないときは null
  function goalDirection(goalWeight) {
    if (!(Number.isFinite(goalWeight) && goalWeight > 0)) return null;
    const oldest = sortedWeights()[0];
    if (!oldest) return null;
    return oldest.kg > goalWeight ? "down" : oldest.kg < goalWeight ? "up" : "same";
  }

  function goalReached(direction, latest, goal) {
    if (direction === "down") return latest <= goal;
    if (direction === "up") return latest >= goal;
    return roundTenth(latest) === roundTenth(goal);
  }

  // 先週比：直近7日間（最新の記録の日の6日前〜その日）の体重の平均 − その前の7日間（13日前〜7日前）の平均。
  // 表示している期間に関係なく、保存されているすべての記録から計算する。どちらかの7日間に記録がなければ null
  function weeklyChange() {
    const sorted = sortedWeights();
    if (!sorted.length) return null;
    const latest = sorted.at(-1);
    const average = (from, to) => {
      const items = sorted.filter(item => item.date >= from && item.date <= to);
      return items.length ? items.reduce((sum, item) => sum + item.kg, 0) / items.length : null;
    };
    const recent = average(addDays(latest.date, -6), latest.date);
    const previous = average(addDays(latest.date, -13), addDays(latest.date, -7));
    return recent === null || previous === null ? null : { diff: recent - previous, latest };
  }

  // 先週比の色の基準のペース（kg/週）：|最新の体重 − 目標| ÷ 今日から達成目標日までの週数。
  // 目標・達成目標日がない、達成目標日が今日以前、目標を達成済みのときは 0.5。0.1〜1.0 に収める
  function weeklyPaceBase(latestKg) {
    const { goalWeight, targetDate } = state.settings;
    const direction = goalDirection(goalWeight);
    const today = localDate();
    let pace = CHART_PACE_DEFAULT;
    if (direction && isValidDate(targetDate) && targetDate > today && !goalReached(direction, latestKg, goalWeight)) {
      pace = Math.abs(latestKg - goalWeight) / (daysBetween(today, targetDate) / 7);
    }
    return Math.min(CHART_PACE_MAX, Math.max(CHART_PACE_MIN, pace));
  }

  // styles.css の :root の色の変数（#rrggbb）を [r, g, b] で返す
  function cssColorRgb(name) {
    const match = /^#([0-9a-f]{6})$/i.exec(getComputedStyle(document.documentElement).getPropertyValue(name).trim());
    return match ? [0, 2, 4].map(i => parseInt(match[1].slice(i, i + 2), 16)) : [0, 0, 0];
  }

  // 薄い灰色（--muted）から「達成」と同じ緑（--green）へ、濃さ 0〜1 でなめらかに変える（どの濃さでも白地で読める）
  function weeklyChangeColor(strength) {
    const from = cssColorRgb("--muted"), to = cssColorRgb("--green");
    const t = Math.min(1, Math.max(0, strength));
    return `rgb(${from.map((value, i) => Math.round(value + (to[i] - value) * t)).join(", ")})`;
  }

  // グラフの上の小さなカード3つ：最新（日付）・先週比・目標まで。出せないところは「—」
  function weightChartStats(values, goalWeight) {
    if (!values.length) return "";
    const latest = values.at(-1);
    const direction = goalDirection(goalWeight);
    const card = (label, value, tone = "", style = "") => `<div class="chart-stat${tone ? ` ${tone}` : ""}"><span class="chart-stat-label">${label}</span><strong class="chart-stat-value"${style ? ` style="${style}"` : ""}>${value}</strong></div>`;
    const latestCard = card(`最新<small>（${chartDateText(latest.date)}）</small>`, `${kgText(latest.kg)}<small> kg</small>`);
    // 先週比の色：変化なし・よくない方向は薄い灰色。よい方向は大きさ ÷ 基準のペースに合わせて灰色→濃い緑（基準より速くても濃い緑のまま）。
    // よい方向は目標の向きで決め、目標がなければ減ったとき
    const weekly = weeklyChange();
    let weekCard;
    if (weekly) {
      const diff = Math.sign(weekly.diff) * roundTenth(Math.abs(weekly.diff)); // 大きさを丸めてから符号を付ける（−0.25 も +0.25 も 0.3 に）
      const good = diff !== 0 && (diff < 0) === (direction !== "up");
      const color = weeklyChangeColor(good ? Math.abs(weekly.diff) / weeklyPaceBase(weekly.latest.kg) : 0);
      weekCard = card("先週比", `${diff === 0 ? "±" : diff > 0 ? "+" : "−"}${kgText(Math.abs(diff))}<small> kg</small>`, "is-weekly", `color: ${color}`);
    } else {
      weekCard = card("先週比", "—", "is-flat");
    }
    let goalCard;
    if (direction) {
      goalCard = goalReached(direction, latest.kg, goalWeight)
        ? card("目標まで", "達成", "is-good")
        : card("目標まで", `<small>あと </small>${kgText(roundTenth(Math.abs(latest.kg - goalWeight)))}<small> kg</small>`);
    } else {
      goalCard = card("目標まで", "—", "is-flat");
    }
    return latestCard + weekCard + goalCard;
  }

  // 目標の線の表示：「いつまで」が達成目標日のときはいつも表示し、凡例のボタンは押せない。それ以外のときは settings の showGoalLine（初期値 false）に従う
  function goalLineState(range, goalWeight) {
    const hasGoal = Number.isFinite(goalWeight) && goalWeight > 0;
    const goalPeriod = hasGoal && isValidDate(state.settings.targetDate) && range.end === state.settings.targetDate;
    return { hasGoal, locked: goalPeriod, shown: hasGoal && (goalPeriod || state.settings.showGoalLine === true) };
  }

  function buildWeightChart(values, range, goalWeight, width, goal) {
    const height = width < 480 ? 218 : 248;
    // 左右の余白を同じにして、描く部分をカードの左右の真ん中にする（左は目盛りの数字、右は横軸の単位「月/日」）
    const side = 46;
    const pad = { top: 30, right: side, bottom: 30, left: side };
    const plotWidth = width - pad.left - pad.right, plotHeight = height - pad.top - pad.bottom;
    const totalDays = Math.max(0, daysBetween(range.start, range.end));
    const x = date => pad.left + (totalDays ? daysBetween(range.start, date) / totalDays : .5) * plotWidth;
    const weightsOnly = values.map(item => item.kg);
    const dataMin = Math.min(...weightsOnly), dataMax = Math.max(...weightsOnly);
    // 目標の線を表示しているときは、いつも縦の範囲に目標を含めて線を引く（記録から遠くても）。表示していないときは範囲に含めない
    const rangeValues = [dataMin, dataMax, ...(goal.shown ? [goalWeight] : [])];
    const scale = niceWeightScale(Math.min(...rangeValues), Math.max(...rangeValues));
    const y = value => pad.top + ((scale.hi - value) / (scale.hi - scale.lo || 1)) * plotHeight;
    const grid = scale.ticks.map(value =>
      `<line x1="${pad.left}" y1="${y(value)}" x2="${width - pad.right}" y2="${y(value)}" stroke="#e3e8e0" stroke-width="1"/>` +
      `<text x="${pad.left - 7}" y="${y(value) + 4}" text-anchor="end" font-size="11" fill="#727b71">${chartTickText(value, scale.step)}</text>`
    ).join("");
    // 軸の単位：縦軸の目盛りの数字の真上に「kg」（数字と右端をそろえる）、横軸の右の余白に「月/日」（日付の文字と同じ高さ）
    const dateY = height - 10;
    const units = `<text x="${pad.left - 7}" y="${y(scale.hi) - 14}" text-anchor="end" font-size="11" fill="#727b71">kg</text>` +
      `<text x="${width - pad.right + 7}" y="${dateY}" text-anchor="start" font-size="11" fill="#727b71">月/日</text>`;
    // 横軸の日付：期間に合わせて重ならない数（2〜5個）。ローカルの日付で作る。年をまたぐときは、最初と年が変わった日付に年を付ける
    const labelCount = totalDays === 0 ? 1 : Math.max(2, Math.min(5, Math.floor(plotWidth / 60), totalDays + 1));
    const labelDays = labelCount === 1 ? [0] : [...new Set(Array.from({ length: labelCount }, (_, i) => Math.round(i * totalDays / (labelCount - 1))))];
    const crossesYear = range.start.slice(0, 4) !== range.end.slice(0, 4);
    let previousYear = "";
    const dateLabels = labelDays.map((days, index) => {
      const date = addDays(range.start, days);
      const year = date.slice(0, 4);
      const text = crossesYear && year !== previousYear ? `${year}/${chartDateText(date)}` : chartDateText(date);
      previousYear = year;
      const anchor = labelDays.length === 1 ? "middle" : index === 0 ? "start" : index === labelDays.length - 1 ? "end" : "middle";
      return `<text x="${x(date)}" y="${dateY}" text-anchor="${anchor}" font-size="11" fill="#727b71"><title>${date}</title>${text}</text>`;
    }).join("");
    // 日付の文字が出ている位置にだけ、横の目盛りの線と同じ薄さの縦線
    const dateLines = labelDays.map(days => { const lineX = x(addDays(range.start, days)); return `<line x1="${lineX}" y1="${pad.top}" x2="${lineX}" y2="${height - pad.bottom}" stroke="#e3e8e0" stroke-width="1"/>`; }).join("");
    // 記録の線：点より薄い緑・2px
    const points = values.map(item => ({ x: x(item.date), y: y(item.kg), date: item.date, kg: item.kg }));
    const line = points.length > 1
      ? `<polyline class="chart-weight-line" points="${points.map(p => `${p.x},${p.y}`).join(" ")}" fill="none" style="stroke: ${CHART_LINE_COLOR}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
      : "";
    // 点：白いふちなしの半径3px、すべて同じ色（線より濃い緑）。点が多いときは描かず線だけ。<title> は残す
    const dots = points.length >= CHART_DENSE_POINTS ? "" : points.map(p =>
      `<circle class="chart-dot" cx="${p.x}" cy="${p.y}" r="3" style="fill: ${CHART_DOT_COLOR}"><title>${p.date}: ${kgText(p.kg)}kg</title></circle>`).join("");
    const goalLine = goal.shown
      ? `<line x1="${pad.left}" y1="${y(goalWeight)}" x2="${width - pad.right}" y2="${y(goalWeight)}" stroke="${CHART_GOAL_COLOR}" stroke-width="2" stroke-dasharray="7 5"><title>目標体重 ${kgText(goalWeight)}kg</title></line>`
      : "";
    const svg = `<svg class="chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="体重推移グラフ ${range.start}から${range.end}">${grid}${dateLines}${units}${goalLine}${line}${dots}${dateLabels}<g class="chart-tip" hidden></g></svg>`;
    // 凡例：線の印＋文字だけ。「記録した体重」は切り替えない。「目標 ○ kg」は線の表示・非表示を切り替えるボタン（aria-pressed。見た目は文字と線の印だけ）。
    // 「いつまで」が達成目標日のときは表示中の見た目のまま押せない（aria-disabled。押すとトースト）
    const legend = `<span class="legend-item"><i class="legend-weight"></i>記録した体重</span>` + (goal.hasGoal
      ? `<button type="button" class="legend-goal-toggle" data-chart-goal-toggle aria-pressed="${goal.shown}"${goal.locked ? ' aria-disabled="true"' : ""}><i class="legend-goal"></i>目標 ${kgText(goalWeight)} kg</button>`
      : "");
    return { svg, legend, points, width, height, pad };
  }

  // 点（または近く）をタップ・クリックすると、その日の日付と体重をグラフの中に小さく出す。押せる範囲は点より広い（24px以内でいちばん近い点）。
  // 選んだ点だけ少し大きくして、ふちを付ける
  function showChartTip(chart, point) {
    const svg = $("#weight-chart svg");
    const tip = svg?.querySelector(".chart-tip");
    if (!tip) return;
    if (!point) { tip.setAttribute("hidden", ""); tip.replaceChildren(); chartState.selected = null; return; }
    chartState.selected = point.date;
    const text = `${chartDateText(point.date)} ${kgText(point.kg)} kg`;
    const boxWidth = text.length * 7.4 + 16, boxHeight = 24;
    const left = Math.min(Math.max(point.x - boxWidth / 2, chart.pad.left), chart.width - chart.pad.right - boxWidth);
    let top = point.y - boxHeight - 10;
    if (top < 2) top = point.y + 10;
    tip.innerHTML = `<circle cx="${point.x}" cy="${point.y}" r="5" style="fill: var(--green-dark)" stroke="white" stroke-width="2"/>` +
      `<rect x="${left}" y="${top}" width="${boxWidth}" height="${boxHeight}" rx="7" fill="#263a2d"/>` +
      `<text x="${left + boxWidth / 2}" y="${top + 16}" text-anchor="middle" font-size="12" font-weight="700" fill="white">${escapeHtml(text)}</text>`;
    tip.removeAttribute("hidden");
  }

  function drawWeightChart() {
    const box = $("#weight-chart");
    if (!box || !chartState) return;
    const values = weightChartValues(chartState.range);
    const legend = $("#chart-legend");
    $("#chart-stats").innerHTML = weightChartStats(values, chartState.goalWeight);
    if (!values.length) {
      const hasGoal = Number.isFinite(chartState.goalWeight) && chartState.goalWeight > 0;
      box.innerHTML = `<div class="empty">体重の記録がありません。${hasGoal ? `目標体重 ${kgText(chartState.goalWeight)} kg は保存されています。` : "目標体重も未設定です。"}</div>`;
      legend.innerHTML = "";
      chartState.width = null;
      return;
    }
    const width = Math.max(240, Math.round(box.clientWidth));
    const goal = goalLineState(chartState.range, chartState.goalWeight);
    const chart = buildWeightChart(values, chartState.range, chartState.goalWeight, width, goal);
    chartState.width = width;
    chartState.chart = chart;
    chartState.selected = null;
    box.innerHTML = chart.svg;
    legend.innerHTML = chart.legend;
    legend.querySelector("[data-chart-goal-toggle]")?.addEventListener("click", toggleGoalLine);
    const svg = box.querySelector("svg");
    svg.addEventListener("click", event => {
      const rect = svg.getBoundingClientRect();
      const px = (event.clientX - rect.left) * (chart.width / rect.width), py = (event.clientY - rect.top) * (chart.height / rect.height);
      let nearest = null, best = Infinity;
      for (const point of chart.points) {
        const distance = Math.hypot(point.x - px, point.y - py);
        if (distance < best) { best = distance; nearest = point; }
      }
      showChartTip(chart, best <= 24 ? nearest : null);
    });
  }

  // 凡例の「目標」：線の表示・非表示を切り替えて settings の showGoalLine に保存する。「いつまで」が達成目標日のときは消せない（トーストだけ）
  async function toggleGoalLine() {
    const goal = goalLineState(chartState.range, chartState.goalWeight);
    if (goal.locked) return showToast("いつまでが達成目標日のときは、目標の線を消せません。");
    try {
      await saveSettings({ ...state.settings, showGoalLine: state.settings.showGoalLine !== true });
      drawWeightChart();
      $("#chart-legend [data-chart-goal-toggle]")?.focus({ preventScroll: true });
    } catch (error) { showToast(error.message, true); }
  }

  // 履歴のページを描いたあとに呼ぶ。幅が変わったら描き直す
  function mountWeightChart(range, goalWeight) {
    chartState?.observer?.disconnect();
    chartState = { range, goalWeight, observer: null, width: null };
    drawWeightChart();
    const box = $("#weight-chart");
    if (box && "ResizeObserver" in window) {
      chartState.observer = new ResizeObserver(() => {
        if (chartState?.width && Math.round(box.clientWidth) !== chartState.width) drawWeightChart();
      });
      chartState.observer.observe(box);
    }
  }

  function renderBackup() {
    app.innerHTML = `<div class="page">
      <section class="card"><h2>バックアップ</h2><p class="hint">食品マスター・食事記録・体重記録を1つのJSONファイルに保存します。ファイルアプリやiCloud Driveなど、端末の外にもコピーして保管してください。</p>
        <div class="backup-actions"><button id="export-json" class="button primary" type="button">全データをバックアップ</button><button id="export-csv" class="button secondary" type="button">記録一覧をCSVで書き出す</button><button id="import-json" class="button secondary" type="button">バックアップから復元</button><input id="backup-file" class="file-input" type="file" accept="application/json,.json"></div>
      </section>
      <section class="card"><h2>このアプリの保存について</h2><div class="privacy-note"><p>記録はこの端末のブラウザーの中だけに保存され、外部のサーバーには送信されません。</p><p>ブラウザーのデータ消去や端末の故障に備えて、定期的にバックアップしてください。</p></div><p class="hint">ホーム画面に追加してオフライン利用する場合、初回はHTTPSでアプリを読み込む必要があります。</p></section>
      </div>`;
    $("#export-json").addEventListener("click", exportJson);
    $("#export-csv").addEventListener("click", exportCsv);
    $("#import-json").addEventListener("click", () => $("#backup-file").click());
    $("#backup-file").addEventListener("change", importJson);
  }

  function downloadFile(content, type, name) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJson() {
    const backup = {
      app: "genryo-note", version: BACKUP_VERSION, exportedAt: new Date().toISOString(),
      foods: state.foods, meals: state.meals, weights: state.weights,
      settings: {
        goalWeight: state.settings.goalWeight,
        targetDate: state.settings.targetDate,
        chartRangeMode: state.settings.chartRangeMode,
        chartStart: state.settings.chartStart,
        chartEnd: state.settings.chartEnd,
        showGoalLine: state.settings.showGoalLine === true
      }
    };
    downloadFile(JSON.stringify(backup, null, 2), "application/json", `genryo-note-backup-${localDate()}.json`);
    showToast("バックアップファイルを作成しました。");
  }

  // 文字の値が = + - @ タブ 改行 で始まるときは先頭に ' を付け、Excel などで数式として扱われないようにする（CSVインジェクション対策）。
  // 数値（number）はそのまま出す
  function csvCell(value) {
    let text = String(value ?? "");
    if (typeof value === "string" && /^[=+\-@\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function exportCsv() {
    const rows = [["日付", "合計カロリー(kcal)", "タンパク質(g)", "脂質(g)", "炭水化物(g)", "PFC(P/F/C)", "体重(kg)", "食品名", "数量", "単位", "食品カロリー(kcal)", "食品タンパク質(g)", "食品脂質(g)", "食品炭水化物(g)"]];
    for (const date of recordedDates().sort()) {
      const dailyMeals = mealsFor(date);
      const total = totalsFor(date);
      const weight = state.weights.find(item => item.date === date);
      if (!dailyMeals.length) rows.push([date, "", "", "", "", "", weight?.kg ?? "", "", "", "", "", "", "", ""]);
      else dailyMeals.forEach((meal, index) => rows.push([
        date, index === 0 ? total.calories : "", index === 0 ? total.protein : "", index === 0 ? total.fat : "", index === 0 ? total.carbohydrate : "",
        index === 0 ? `${numberText(pfcPercentages(total).protein)}%/${numberText(pfcPercentages(total).fat)}%/${numberText(pfcPercentages(total).carbohydrate)}%` : "",
        index === 0 ? (weight?.kg ?? "") : "", meal.foodName, meal.amount, meal.unit, meal.calories, meal.protein, meal.fat || 0, meal.carbohydrate || 0
      ]));
    }
    const csv = "\uFEFF" + rows.map(row => row.map(csvCell).join(",")).join("\r\n");
    downloadFile(csv, "text/csv;charset=utf-8", `genryo-note-history-${localDate()}.csv`);
    showToast("CSVファイルを作成しました。");
  }

  function validNonNegative(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }

  function validateBackup(data) {
    if (!data || typeof data !== "object" || data.app !== "genryo-note" || ![1, BACKUP_VERSION].includes(data.version) ||
        !Array.isArray(data.foods) || !Array.isArray(data.meals) || !Array.isArray(data.weights)) {
      throw new Error("このバックアップ形式には対応していないか、ファイルの構造が正しくありません。");
    }
    const ids = new Set();
    // 栄養値（基準量あたり）が上限以内か。fat・carbohydrate がない古い形式は 0 とみなす
    const perUnitWithin = (item, keys) => keys.every(([key, max], index) => {
      const value = item[key];
      return (index >= 2 && value === undefined) || inRange(value, 0, max);
    });
    const textWithin = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
    for (const food of data.foods) {
      if (!food || typeof food.id !== "string" || ids.has(food.id) || !textWithin(food.name, LIMITS.nameLength) ||
          !["unit", "weight"].includes(food.type) ||
          !perUnitWithin(food, [["calories", LIMITS.calories], ["protein", LIMITS.nutrient], ["fat", LIMITS.nutrient], ["carbohydrate", LIMITS.nutrient]]) ||
          !inRange(food.baseAmount, LIMITS.amountMin, LIMITS.amountMax) || !textWithin(food.unit, LIMITS.unitLength) ||
          (food.type === "weight" && (food.baseAmount !== 100 || food.unit !== "g"))) {
        throw new Error(`食品マスターのデータが不正か、上限（食品名${LIMITS.nameLength}文字・単位${LIMITS.unitLength}文字・基準量${limitText(LIMITS.amountMax)}・${NUTRITION_LIMIT_TEXT}）を超えています。既存データは変更されていません。`);
      }
      ids.add(food.id);
    }
    const mealIds = new Set();
    const dailyTotals = new Map();
    for (const meal of data.meals) {
      if (!meal || typeof meal.id !== "string" || mealIds.has(meal.id) || !isValidDate(meal.date) ||
          (meal.foodId !== null && typeof meal.foodId !== "string") || !textWithin(meal.foodName, LIMITS.nameLength) || !textWithin(meal.unit, LIMITS.unitLength) ||
          !["unit", "weight"].includes(meal.type) ||
          !inRange(meal.amount, LIMITS.amountMin, LIMITS.amountMax) ||
          !validNonNegative(meal.calories) || !validNonNegative(meal.protein) ||
          !perUnitWithin(meal, [["caloriesPerUnit", LIMITS.calories], ["proteinPerUnit", LIMITS.nutrient], ["fatPerUnit", LIMITS.nutrient], ["carbohydratePerUnit", LIMITS.nutrient]])) {
        throw new Error(`食事記録のデータが不正か、上限（食品名${LIMITS.nameLength}文字・単位${LIMITS.unitLength}文字・数量${limitText(LIMITS.amountMax)}・${NUTRITION_LIMIT_TEXT}・日付${LIMITS.dateMin}〜${LIMITS.dateMax}）を超えています。既存データは変更されていません。`);
      }
      const expected = calculateMealNutrition(meal.type, meal.amount, meal.caloriesPerUnit, meal.proteinPerUnit, meal.fatPerUnit || 0, meal.carbohydratePerUnit || 0);
      if (meal.calories !== expected.calories || meal.protein !== expected.protein ||
          (meal.fat || 0) !== expected.fat || (meal.carbohydrate || 0) !== expected.carbohydrate) {
        throw new Error("食事の栄養値と数量が一致しません。既存データは変更されていません。");
      }
      if (!withinNutritionLimits(expected)) {
        throw new Error(`${meal.date}の食事記録の栄養値が上限（${NUTRITION_LIMIT_TEXT}）を超えています。既存データは変更されていません。`);
      }
      const previous = dailyTotals.get(meal.date) || { calories: 0, protein: 0, fat: 0, carbohydrate: 0 };
      const next = { calories: previous.calories + meal.calories, protein: previous.protein + meal.protein, fat: previous.fat + (meal.fat || 0), carbohydrate: previous.carbohydrate + (meal.carbohydrate || 0) };
      if (!withinNutritionLimits(next, true)) {
        throw new Error(`${meal.date}の1日の合計が上限（${DAY_LIMIT_TEXT}）を超えています。既存データは変更されていません。`);
      }
      dailyTotals.set(meal.date, next);
      mealIds.add(meal.id);
    }
    const weightDates = new Set();
    for (const weight of data.weights) {
      if (!weight || !isValidDate(weight.date) || weightDates.has(weight.date) ||
          typeof weight.kg !== "number" || !Number.isFinite(weight.kg) || weight.kg <= 0 || weight.kg > LIMITS.backupWeightMax) {
        throw new Error(`体重記録のデータが不正か、範囲（0より大きく${limitText(LIMITS.backupWeightMax)}kg以下・日付${LIMITS.dateMin}〜${LIMITS.dateMax}）を外れています。既存データは変更されていません。`);
      }
      weightDates.add(weight.date);
    }
    const settings = data.settings === undefined
      ? { ...DEFAULT_SETTINGS }
      : { ...DEFAULT_SETTINGS, ...data.settings, id: "app" };
    if (data.settings !== undefined) {
      if (!data.settings || typeof data.settings !== "object" || Array.isArray(data.settings)) {
        throw new Error("目標・グラフの期間・グラフの表示の設定が不正です。既存データは変更されていません。");
      }
      const hasGoalWeight = settings.goalWeight !== null;
      const hasTargetDate = settings.targetDate !== "";
      if ((hasGoalWeight && (typeof settings.goalWeight !== "number" || !Number.isFinite(settings.goalWeight) ||
          settings.goalWeight <= 0 || settings.goalWeight > LIMITS.backupWeightMax)) ||
          (hasTargetDate && !isValidDate(settings.targetDate)) ||
          (hasTargetDate && !hasGoalWeight) ||
          // グラフの期間：chartRangeMode の形（auto / manual。manual は日付が正しく chartStart ≦ chartEnd）と、v87 の chartPeriod の形
          // （決まった値。"custom" は日付が正しく chartStart ≦ chartEnd）の両方を受け付ける
          ("chartPeriod" in settings && !LEGACY_CHART_PERIODS.includes(settings.chartPeriod)) ||
          (settings.chartPeriod === "custom" &&
            (!isValidDate(settings.chartStart) || !isValidDate(settings.chartEnd) || settings.chartStart > settings.chartEnd)) ||
          !["auto", "manual"].includes(settings.chartRangeMode) ||
          (!("chartPeriod" in settings) && settings.chartRangeMode === "manual" &&
            (!isValidDate(settings.chartStart) || !isValidDate(settings.chartEnd) || settings.chartStart > settings.chartEnd)) ||
          // 目標の線の表示（ない古いバックアップは false）。以前の項目（showWeight・showTrend・showGoal）は true / false なら受け付けて、読み込むときは無視する
          typeof settings.showGoalLine !== "boolean" ||
          OBSOLETE_SETTING_KEYS.some(key => key in settings && typeof settings[key] !== "boolean")) {
        throw new Error("目標・グラフの期間・グラフの表示の設定が不正です。既存データは変更されていません。");
      }
    }
    return {
      foods: data.foods.map(food => ({ ...food, fat: food.fat || 0, carbohydrate: food.carbohydrate || 0 })),
      meals: data.meals.map(meal => ({
        ...meal, foodId: meal.foodId ?? null, fatPerUnit: meal.fatPerUnit || 0,
        carbohydratePerUnit: meal.carbohydratePerUnit || 0, fat: meal.fat || 0, carbohydrate: meal.carbohydrate || 0
      })),
      weights: data.weights, settings: { ...Object.fromEntries(Object.entries(settings).filter(([key]) => !OBSOLETE_SETTING_KEYS.includes(key) && key !== "chartPeriod")), ...normalizeChartSettings(settings, data.weights.map(item => item.date).sort()[0]) }
    };
  }

  async function importJson(event) {
    const input = event.currentTarget;
    const file = input.files[0];
    input.value = "";
    if (!file) return;
    // 非常に大きいファイルは読み込まない（読み込み中に画面が止まるのを防ぐ）
    if (file.size > LIMITS.backupFileBytes) return showToast(`バックアップファイルが大きすぎます（${Math.round(LIMITS.backupFileBytes / 1024 / 1024)}MBまで）。既存データは変更されていません。`, true);
    try {
      const parsed = JSON.parse(await file.text());
      const backup = validateBackup(parsed);
      if (!confirm(`食品${backup.foods.length}件・食事${backup.meals.length}件・体重${backup.weights.length}件を復元します。\n目標とグラフ期間の設定も復元します。\n現在の全データは置き換わります。続けますか？`)) return;
      await replaceAll(backup);
      await refreshData();
      render();
      showToast("バックアップを復元しました。");
    } catch (error) {
      showToast(error instanceof SyntaxError ? "JSONを読み取れません。バックアップファイルを確認してください。" : error.message || "復元に失敗しました。", true);
    }
  }

  tabs.forEach(tab => tab.addEventListener("click", () => {
    state.page = tab.dataset.page;
    render();
    window.scrollTo(0, 0);
  }));

  $("#food-form").elements.type.addEventListener("change", changeFoodType);
  $("#food-form").addEventListener("submit", saveFood);
  $("#quick-food-form").addEventListener("submit", saveQuickFood);
  $("#quick-food-form").elements.type.addEventListener("change", changeQuickFoodType);
  $("#copy-form").elements.sourceDate.addEventListener("change", updateCopyPreview);
  $("#copy-form").addEventListener("submit", copyMeals);
  // 候補一覧だけを書き換え、入力欄は再描画しないため、日本語の変換中も一覧を更新して問題ない
  $("#food-picker-search").addEventListener("input", updateFoodPickerSearch);
  $("#food-picker-search").addEventListener("compositionend", updateFoodPickerSearch);
  $("#food-picker-search").addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    const matches = foodPickerMatches();
    if (matches.length === 1) chooseFood(matches[0].id);
    else event.currentTarget.blur();
  });
  $("#food-picker-list").addEventListener("click", event => {
    const toggle = event.target.closest("[data-toggle-food-detail]");
    if (toggle) {
      const foodId = toggle.dataset.toggleFoodDetail;
      const expanded = !expandedPickerFoods.has(foodId);
      if (expanded) expandedPickerFoods.add(foodId);
      else expandedPickerFoods.delete(foodId);
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.closest(".food-picker-item").classList.toggle("expanded", expanded);
      $(`#${toggle.getAttribute("aria-controls")}`).hidden = !expanded;
      return;
    }
    const option = event.target.closest("[data-pick-food]");
    if (option) chooseFood(option.dataset.pickFood);
  });
  window.visualViewport?.addEventListener("resize", fitFoodPicker);
  $("#food-form").elements.name.addEventListener("input", updateFoodDuplicateNote);
  $("#food-form").elements.name.addEventListener("compositionend", updateFoodDuplicateNote);
  document.querySelectorAll("[data-seibun-target]").forEach(button => button.addEventListener("click", () => openSeibunDialog(button.dataset.seibunTarget)));
  // 食品選択（#food-picker-search）と同じく input と compositionend で一覧だけを書き換える
  $("#seibun-search").addEventListener("input", renderSeibunList);
  $("#seibun-search").addEventListener("compositionend", renderSeibunList);
  $("#seibun-search").addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    const matches = seibunMatches(event.currentTarget.value);
    if (matches.length === 1) chooseSeibunFood(matches[0].code);
    else event.currentTarget.blur();
  });
  $("#seibun-list").addEventListener("click", event => {
    const toggle = event.target.closest("[data-toggle-seibun-detail]");
    if (toggle) {
      const code = toggle.dataset.toggleSeibunDetail;
      const expanded = !expandedSeibunFoods.has(code);
      if (expanded) expandedSeibunFoods.add(code);
      else expandedSeibunFoods.delete(code);
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.closest(".food-picker-item").classList.toggle("expanded", expanded);
      $(`#${toggle.getAttribute("aria-controls")}`).hidden = !expanded;
      return;
    }
    const option = event.target.closest("[data-pick-seibun]");
    if (option) chooseSeibunFood(option.dataset.pickSeibun);
  });
  window.visualViewport?.addEventListener("resize", fitSeibunPicker);
  // シートを開いている間、一覧の外（見出し・検索欄・出典）を指でなぞっても何もスクロールさせない。
  // 一覧の中は、スクロールできるときだけ許す（スクロールできない一覧でなぞると外側へ伝わるため）。
  // 入力欄の上の操作（カーソル移動・文字選択）は妨げない
  for (const sheet of [$("#food-picker-dialog"), $("#seibun-dialog")]) {
    sheet.addEventListener("touchmove", event => {
      if (event.target.closest("input, textarea")) return;
      const list = event.target.closest(".food-picker-list");
      if (list && list.scrollHeight > list.clientHeight) return;
      if (event.cancelable) event.preventDefault();
    }, { passive: false });
  }
  // 検索・選択のシート（成分表の検索・食品選択）を閉じたあとのフォーカス。
  // 閉じるとブラウザーは開く前のフォーカス先（iOS Safari ではタップしたボタンにフォーカスしないため、下のダイアログ自体のことがある）へ戻し、
  // 直前の検索欄のフォーカス枠の状態を引き継いでそこに標準の枠を出すことがある。
  // タップで閉じるときは先に検索欄のフォーカスを外して枠を引き継がせない。キーボードで閉じたときは開いたボタンへ戻す
  // タップで閉じたときにフォーカスが戻った先へ標準の枠が出ていれば、フォーカスを外す
  function clearRestoredFocusRing() {
    const active = document.activeElement;
    if (active && active !== document.body && active.matches(":focus-visible")) active.blur();
  }
  // 体重グラフ：グラフの外をタップすると点の値の表示を消す。ResizeObserver がない環境では画面の幅の変化で描き直す
  document.addEventListener("click", event => {
    if (chartState?.selected && chartState.chart && !event.target.closest("#weight-chart svg")) showChartTip(chartState.chart, null);
  });
  window.addEventListener("resize", () => {
    if (!("ResizeObserver" in window) && chartState?.width && $("#weight-chart") && Math.round($("#weight-chart").clientWidth) !== chartState.width) drawWeightChart();
  });
  // 目標のダイアログ：保存・クリア（入力のチェック・丸め・上限は saveGoal / clearGoal）
  $("#goal-form").addEventListener("submit", saveGoal);
  // 達成目標日の「消す」：欄だけを空にする（保存はダイアログの「保存」）。ボタンが隠れるので、フォーカスは dialog 自体に移す
  $("#goal-form").elements.targetDate.addEventListener("input", updateClearTargetDate);
  $("#goal-form").elements.targetDate.addEventListener("change", updateClearTargetDate);
  keepDateResetOnOpen($("#goal-form").elements.targetDate);
  keepDateResetOnOpen($("#copy-form").elements.sourceDate);
  $("#clear-target-date").addEventListener("click", () => {
    $("#goal-form").elements.targetDate.value = "";
    updateClearTargetDate();
    $("#goal-dialog").focus();
  });
  $("#clear-goal").addEventListener("click", clearGoal);
  // 編集ダイアログの操作の行の左端の「削除」：確認でOKなら食品と紐づく記録を消してダイアログを閉じる。キャンセルなら開いたまま
  $("#food-delete").addEventListener("click", async () => {
    if (await deleteFood($("#food-form").elements.id.value)) $("#food-dialog").close();
  });
  // 日付の一覧のシート：年月の見出しで開閉（aria-expanded）、日付を押したら選ぶ。背景・Esc・×で閉じ、閉じたらスクロールの固定を戻す
  $("#date-sheet-list").addEventListener("click", event => {
    const month = event.target.closest(".date-sheet-month");
    if (month) {
      const open = month.getAttribute("aria-expanded") !== "true";
      month.setAttribute("aria-expanded", String(open));
      document.getElementById(month.getAttribute("aria-controls")).hidden = !open;
      return;
    }
    const day = event.target.closest("[data-sheet-date]");
    if (day) applyChartDate($("#date-sheet").dataset.which, day.dataset.sheetDate);
  });
  $("#date-sheet").addEventListener("click", event => { if (event.target === event.currentTarget) closeDateSheet(); });
  $("#date-sheet").addEventListener("close", unlockSheetScroll);
  window.addEventListener("resize", () => { if ($("#date-sheet").open) applyDateSheetHeight(); });
  // メニュー：背景（dialog の外側）を押す・Esc・キャンセルで閉じる。閉じたらスクロールの固定を戻す
  $("#action-sheet").addEventListener("click", event => { if (event.target === event.currentTarget) closeActionSheet(); });
  $("#action-sheet").addEventListener("close", unlockSheetScroll);
  $("#seibun-dialog").addEventListener("close", () => {
    unlockSheetScroll();
    const owner = $(seibunTarget === "quick" ? "#quick-food-dialog" : "#food-dialog");
    if (!keyboardInput) clearRestoredFocusRing();
    else if (owner.open) owner.querySelector(".seibun-open").focus({ preventScroll: true });
  });
  $("#food-picker-dialog").addEventListener("close", () => {
    unlockSheetScroll();
    if (!keyboardInput) clearRestoredFocusRing();
    else $("#food-picker-open")?.focus({ preventScroll: true });
  });
  document.addEventListener("keydown", () => { keyboardInput = true; }, true);
  document.addEventListener("pointerdown", () => { keyboardInput = false; }, true);
  document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => {
    const dialog = $(`#${button.dataset.close}`);
    if (dialog.classList.contains("food-picker")) closeSheet(dialog);
    else dialog.close();
  }));

  async function initialize() {
    if ("serviceWorker" in navigator && globalThis.isSecureContext) {
      navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).catch(error => {
        console.error("オフライン機能を準備できませんでした:", error);
        showToast("オフライン機能の準備に失敗しました。HTTPSで開いてください。", true);
      });
    }
    try {
      await refreshData();
      render();
      // 端末の容量不足などでブラウザーにデータを消されにくくするよう依頼する（許可されなくても動作は同じ）
      if (navigator.storage?.persist) {
        try {
          await navigator.storage.persist();
        } catch (error) {
          console.error("端末内データの永続化を要求できませんでした:", error);
        }
      }
    } catch (error) {
      app.innerHTML = `<section class="card"><h2>アプリを起動できません</h2><p class="hint">${escapeHtml(error.message)}</p><p class="hint">IndexedDBが利用できるSafariまたは対応ブラウザーで開いてください。</p></section>`;
    }
  }

  initialize();
})();
