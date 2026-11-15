# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

「カテログ」— 食品マスター・食事・体重を端末内（IndexedDB）に記録する日本語のオフライン対応PWA。フレームワーク・ビルド工程・外部ライブラリ・外部通信はなく、素のHTML/CSS/JSのみ。UI文言・エラーメッセージ・トーストはすべて日本語で書く。

- **表示名と中の識別名**：画面や端末に出る名前は「カテログ」（`index.html` の `<title>`・ヘッダーの h1・`apple-mobile-web-app-title`、`manifest.webmanifest` の name / short_name、`capacitor.config.json` の appName、iOS の `ios/App/App/Info.plist` の `CFBundleDisplayName`（ホーム画面の名前。appName は `cap add` のときにしか Info.plist に反映されないので、ここも直す））。中の識別名は `genryo-note`（旧名「減量ノート」のときに付けた名前）のまま変えない：IndexedDB のデータベース名 `genryo-note`、Service Worker のキャッシュ名 `genryo-note-vNN`、バックアップの `app: "genryo-note"`、バックアップ・CSV のファイル名（`genryo-note-backup-…` 等）、Capacitor の appId `jp.example.genryosupport`、フォルダ名。変えると、今までの端末のデータ（IndexedDB はデータベース名で探す）や、前に作ったバックアップファイル（`validateBackup` が `app` を確かめる）が読めなくなり、iOS では別のアプリとして扱われるため。
- **色の決まり**（`styles.css` の `:root`）：アプリの緑は4段階の変数だけを使い、CSS・app.js（SVG の中も）に緑を直接書かない。`--green-dark`（押したとき・薄い背景の上の文字・アプリ名）、`--green`（ボタン・アイコンなどのメインの色。icon.svg と同じ #317456）、`--green-line`（フォーカスの枠・選んでいる状態の枠・グラフの記録の線など薄い線。グラフの点は `--green` で、線は点より薄い）、`--mint`（ごく薄い背景）。SVG の中で変数を使うときは属性ではなく style で指定する（`style="stroke: var(--green-line)"`）。先週比の色は `cssColorRgb` で `--muted` と `--green` の値を読んで混ぜる。カロリーは `--calorie`（#4e9483、少し青みの緑）で、アプリの緑とは別の色にする。タンパク質・脂質・炭水化物・灰色・赤（削除）・オレンジ（目標）は個別の値のまま。
- **ヘッダーと上のタブ**：ヘッダーは左にアプリのアイコン（`<img src="./icon.svg" alt="">`、28px）、8px 空けて名前（`--green-dark`、太さ800）。左右の余白は #app と同じ `--app-pad`（14px、430px以下は10px）なので、アイコンの左端はタブの左端にそろう。タブは背景色の入れ物 `.tabs-bar`（sticky）で包み、スクロールすると画面の上の端から `--tabs-top`（`env(safe-area-inset-top)` ＋左右と同じ幅）空けて止まる。入れ物を負の margin で上と左右に広げ、背景色はタブの上の隙間（高さ `--tabs-top`）だけに塗る（`linear-gradient(var(--paper), var(--paper)) top / 100% var(--tabs-top) no-repeat`）。タブの左右と丸い角の外側は透明なので、スクロールした中身がタブの角のまわりに見える（入れ物全体を塗ると、角の外側に四角い背景色が残って中身が四角く切れて見えた）。入れ物は `pointer-events: none`（透明な部分の下の中身を押せる）、タブ（`.tabs`）と上の隙間（`.tabs-bar::before`。見えない中身を押さないよう受け止める）は `pointer-events: auto`。スクロールしていないときは入れ物がヘッダーの下に重なるので、ヘッダーを `z-index` で上にしている。

ビルド・lint・テストの仕組みは存在しない。変更の確認はブラウザーで実際に開いて行う。

## ファイル構成とソースの正本

- **ルート直下の `index.html` / `app.js` / `styles.css` / `sw.js` / `manifest.webmanifest` / `icon.svg` / `apple-touch-icon.png` / `icon-192.png` / `icon-512.png` / `seibun.json` の10ファイルが正本。** 編集はここで行う（`seibun.json` だけは手で編集せず変換スクリプトで生成する）。
- **アプリのアイコン**：`icon.svg`（おにぎり。角の丸い緑の正方形 `rx="44"`）が元で、アプリの中のヘッダー・ブラウザーのタブに使う。PNG（`apple-touch-icon.png` 180px：iPhone のホーム画面用、`icon-192.png`・`icon-512.png`：manifest 用、iOS アプリの `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png` 1024px）は、icon.svg の1つ目の rect から `rx="44"` を外した角なしの正方形を書き出す（iPhone が自分の形に角を丸めるため。透明な部分を作らない。iOS のアイコンは透明が使えないので、アルファなしの RGB の PNG にする）。書き出しはヘッドレスの Chrome の canvas で描いて画素を取り出し、Python の標準ライブラリ（zlib）で PNG にする（画像のライブラリは入れない）。海苔（2つ目の rect）はわざとおにぎりの下の端（y=148）より下（y=156）まで伸ばしてある。境目をちょうど148にすると、縮小したときに海苔とおにぎりの境目に白い線が出るため。縮めないこと。1024px の PNG は Capacitor 用なので、アプリのファイル（`APP_FILES`・`www/`）には入れない。
- `www/` は Capacitor の `webDir`（`capacitor.config.json`）で、ルートの10ファイルを手動コピーしたもの。`ios/App/App/public/` はさらに `cap sync` でコピーされたもの。どちらも直接編集しない。
- ルートのWebファイルを変更したら：`sw.js` の `CACHE` を上げる → 10ファイルを `www/` にコピー → `npx cap sync ios`（Windowsでも動く。Package.swift と `ios/App/App/capacitor.config.json` も再生成される。Xcodeでのビルドは Mac が必要）。
- Capacitor プラグインは使っていない（2026-11 に未使用の filesystem / share を削除済み）。`ios/App/CapApp-SPM/Package.swift` は CLI 管理ファイルなので手で編集しない。
- 変更前後で3か所が一致しているかは `md5sum` / `cmp` で確認できる。Git Bash の `sed -i` は CRLF を LF に変えるので、CRLF のファイル（`app.js`、`sw.js` 等）の編集では注意する。
- ルートの `seibun.json` は成分表（八訂 増補2023年）の検索用データで、`python tools/convert_seibun.py` が `tools/` の Excel・`seibun_readings.json`（読み・表記の辞書）・`seibun_aliases.json`（言い換え表）・`seibun_labels.json`（食品番号 → 分かりやすい名前 `label`。表にない食品番号は警告）から生成する（標準ライブラリのみ）。label は単語に分けて `search` と `terms` にも入る。直接編集しない。正規化のルールはスクリプト冒頭のコメントが正本。`updated` は「表全体」シート1行目の「更新日：○年○月○日」から取る。Excel を差し替えたら再生成し、`CACHE` を上げて上記の手順でコピーする。

## 開発用サーバー

```powershell
python start_server.py --cert cert.pem --key key.pem [--root-ca <mkcertのrootCA.pem>]
```

- HTTPS（既定 8443）でアプリを、HTTP（既定 8000）で `/rootCA.pem` のみを配信する。Service Worker は secure context でしか登録されないため HTTPS が必要。
- `start_server.py` は `APP_FILES` に列挙したパスしか返さない（それ以外は404）。**新しい静的ファイルを追加したら `start_server.py` の `APP_FILES` と `sw.js` の `APP_FILES` の両方に追加する。**
- `cert.pem` / `key.pem` は mkcert で生成したLAN IP用のローカル証明書。iPhoneへの導入手順は README.md を参照。

## Service Worker（`sw.js`）

- キャッシュ名 `genryo-note-vNN`。**アプリのファイル（HTML/CSS/JS等）を変更したら `CACHE` の番号を必ず上げる。** 上げないと古いキャッシュが残る。
- 戦略はキャッシュ優先。更新は `CACHE` を上げたときの install で全ファイルを `addAll` し、全部そろったときだけ切り替える（1つでも失敗したら旧版を維持）。ナビゲーション失敗時は `index.html` にフォールバック。
- **stale-while-revalidate（1ファイルずつ裏で更新）に戻さない。** v54 まではそうしていて、更新が中断すると旧 `index.html` と新 `app.js` が混ざり、オフラインで起動できなくなる不具合が起きた（`app.js` はトップレベルで `index.html` の要素にイベントを登録するため、HTML と JS の版がずれると停止する）。

## `app.js` のアーキテクチャ

単一のIIFE（`"use strict"`）にすべてが入っている。

- **状態**：グローバルな `state` オブジェクト（`page`, `date`, `foods`, `meals`, `weights`, `settings`, 検索・ソート条件など）。`refreshData()` がIndexedDBの全ストアを読み込んで `state` に入れる。
- **描画**：`render()` が `state.page` に応じて `renderToday` / `renderHistory` / `renderFoods` / `renderBackup` を呼び、`#page-content` の innerHTML をテンプレート文字列で丸ごと書き換える。ユーザー入力を埋め込むときは必ず `escapeHtml()` を通す。ダイアログ（食品登録、手入力で追加、ほかの日の食事をコピー等）は `index.html` に静的に定義された `<dialog>`。
- **典型的な更新フロー**：IndexedDBに書き込み → `await refreshData()` → `render()` → `showToast()`。
- **IndexedDB**：DB名 `genryo-note`、`DB_VERSION`。ストアは `foods`(key: id), `meals`(key: id), `weights`(key: date), `settings`(key: id、`id: "app"` の1件のみ。目標 `goalWeight`・`targetDate`、グラフの期間 `chartRangeMode`（"auto"＝最初の記録〜最新の記録 / "manual"＝選んだ期間）・`chartStart`・`chartEnd`（`normalizeChartSettings` が読み替える：v86以前の chartRangeMode の形はそのまま、v87 の `chartPeriod` の形は "custom" → その日付を選んだ期間、"goal" → いつから＝最初の記録の日・いつまで＝達成目標日、それ以外 → auto。`validateBackup` はどちらの形も受け付け、不正な値・日付の順番が逆のものはエラー。JSONバックアップは chartRangeMode の形で書き出す）目標の線の表示 `showGoalLine`（true / false。ない古いデータ・バックアップは false。JSONバックアップにも入れる）。以前の項目 `showWeight`・`showTrend`・`showGoal` は使わない（`OBSOLETE_SETTING_KEYS`）：`validateBackup` は true / false なら受け付けて読み込むときに外し、それ以外の値はエラー。端末の設定からも読み込むときに外す)。ストアやスキーマを変えるときは `DB_VERSION` を上げ `onupgradeneeded` を更新する。
- **食事記録の非正規化**：meal は `foodId` に加え、`foodName`・`type`・`unit`・`caloriesPerUnit` 等の単位あたり栄養値と計算済み合計を自前で保持する（`calculateMealNutrition`）。**食品を編集すると `saveFoodAndUpdateMeals` が同じトランザクションで紐づく全mealを再計算・上書きし、食品を削除すると `deleteFood` が紐づくmealも削除する**（どちらも意図した仕様。維持すること）。「ほかの日の食事をコピー」（`copyMeals`）は `foodId` ごと複製するのでコピー分も対象。画面で「手入力」と呼ぶ記録（「手入力で追加」から作る食品）は `foodId: null`（新しく作るものは `temporary: true` も付く）のmealで、マスターの影響を受けない。手入力かどうかは `temporary` ではなく `foodId == null` で判定する（コピーした記録も同じ扱い）。手入力の meal は、カードの「⋯」のメニューの「編集」から `#quick-food-dialog` の編集モード（隠し項目 `mealId` に値があるとき。空なら新規）で名前・種類・栄養値・数量をその1件だけ直せる（`saveQuickFood` が `id`・`date`・`createdAt`・`temporary` を引き継ぐ）。
- **プレースホルダー**：入力のヒントはすべて「例：〜」にし、ラベルと同じことは書かない。基準量・栄養値などそのほかの入力欄には付けない。今あるもの：食品の登録の食品名は記録のしかたで切り替える（「個数で記録」は「例：納豆」、「重さで記録」は「例：鶏むね肉」。`updateFoodFields` が、ダイアログを開いたとき（編集も）と記録のしかたを変えたときに直す）。食品マスターの検索・食品選択シートの検索・成分表の検索「例：鶏むね肉」、手入力で追加の食品名「例：コンビニのおにぎり」、単位「例：個、パック、本」、目標体重「例：60.0」、食事の数量（追加の欄と `updateAmountLabel` で作り直す欄）「例：1」。例外は状態を表す文字で、体重の欄の「未記録」はそのまま。
- **select の矢印**：`.field select`（アプリ内のすべての select）は標準の矢印を消し（`appearance: none`）、「食品を選択」の欄（`.food-picker-trigger::after`）と同じ形・色・大きさ・位置の矢印を、CSS の中に書いた SVG（data URI）の background-image で描く（select には ::after が使えないため。外部ファイルは使わない）。形は線を含めて10pxの四角の右と下の2pxの線を45度回したもの（::after は content-box なので 8px＋線2px×2）、色は #727b71（--muted と同じ。data URI の中では変数が使えない）。位置は `background-position: right 10.5px top calc(50% - 2.75px)`（四角の中心が右の枠の外側から約19px・上下の中央より約2.5px上）、右の余白は 34px（文字が矢印に重ならない）。「いつから」「いつまで」の欄（`.chart-date-button::after`）は少し小さい（線を含めて9px、右から約14px）。
- **食品マスターの並び替え**：1つの select `#food-sort`（`FOOD_SORT_OPTIONS`：名前順／タンパク質が多い順／少ない順／脂質が多い順／少ない順／炭水化物が多い順／少ない順）。値は `state.foodSort` 1つ（"name" または "protein-desc" のような「栄養素-desc/asc」。`foodSortParts` で分ける。初期値は名前順）。名前順は五十音順（`localeCompare(…, "ja")`）。栄養素の順は `compareFoods` が1kcalあたりの量（`foodNutrientRatio`。カロリーが0以下の食品は0として扱う）で並べ、同じなら五十音順。栄養素で並べているときだけ、各カードに並べる元の数を `foodSortValueMarkup` が「100kcalあたり 20.5g」（小数1桁、その栄養素の色 `.nutrition-○`）で出し、カロリー0の食品は「—」。検索（`state.search`）で絞り込んだあとに並べる。
- **食品の種類**：`type: "unit"`（画面では「個数で記録」。個数×基準量あたり値）と `type: "weight"`（画面では「重さで記録」。基準100g・単位g固定、重量gを入力）。
- **バックアップ**：`exportJson` / `importJson`。`BACKUP_VERSION` を持ち、`validateBackup()` でファイル全体を検査してから `replaceAll()` で全ストアを置き換える（検査失敗時は既存データを変更しない）。データ構造を変えたら `validateBackup` と `BACKUP_VERSION` も合わせて更新する。CSV出力もある（`exportCsv`）。
- **日付**：`YYYY-MM-DD` のローカル日付文字列（`localDate()` / `isValidDate()`）。UTC変換（`toISOString` 等）を使わない。記録のページ（タブ「記録」、内部名は today / `renderToday`）の見出しは `dayHeading()`（どの日も `dateLabel` の形で「2026/11/14(土)の記録」。今日のときは画面側で見出しの下の状態の行に小さく灰色の「今日」（`.day-today`）を出す）。
- **成分表から探す**：`#food-dialog` と `#quick-food-dialog` の「成分表から探す」ボタンが `#seibun-dialog`（`#food-picker-dialog` と同じ構造・クラス）を開く。`seibun.json` は初回だけ `fetch` し、モジュール内の変数 `seibunData` に持つ（state・IndexedDB には入れない）。検索は `normalizeSeibun`（Python の `normalize()` と同じ処理）→ 空白で分けて `terms` で区切る（`seibunSegment`／Python の `segment()`。先頭からの最長一致で決め打ちせず、動的計画法で ① terms にない残りの文字数が少ない → ② 区切った語の数が少ない → ③ 同じなら先頭から長い語を取るもの、を選ぶ。例：「ぎゅうひれ」→「ぎゅう／ひれ」） → 区切った語がすべて当たった食品。語が当たるとは、`search` がそのまま含むか、その語をそれより短い `terms` だけで区切った（覆いきれる場合）すべての部分が当たること（再帰、`seibunPartHits`。例：「鶏胸肉」の「胸肉」→「胸／肉」）。並びは ① `labelKeys` のどれかが検索語全体（正規化）で始まる → ② どれかに検索語全体を含む → ③ それ以外、同じグループ内は「単語の先頭で一致した語の数」→ 食品番号（成分表は主な部位・生が先）で、表示は上位100件。`labelKeys` は `convert_seibun.py` が出力する並び替え専用の値で、label の正規化と、label の単語の中のかなを `seibun_readings.json` の漢字の書き方に置き換えた別の書き方（例：鶏むね肉 → 鶏胸肉）。一覧の表示は label のまま。`convert_seibun.py --try` も同じ当て方・並び順で結果を表示する。一覧には分かりやすい名前（`label`）だけを出し、正式名（`name`）は「栄養成分」の詳細を開いたときだけ小さく出す。選ぶと元のフォームに種類 weight と4つの値を入れるだけで、保存は既存の `saveFood` / `saveQuickFood`。名前欄には新規（食品登録・手入力で追加）のときだけ `label` を入れる（label がない食品は正式名）。既存食品の編集では名前を変えない。保存済みの「個数で記録」の食品（unit）の編集では、トーストを出して開かない（過去の meal の個数が g として再計算されるため）。食品番号は保存しない。
- **数値の表示**：栄養成分・合計・PFCの％は `nutrientText()`（最大で小数1桁、末尾の0なし）、体重・目標体重は `kgText()`（いつも小数1桁）、体重の入力欄の値は `kgInputValue()`。どれも `roundTenth()`（10進数として四捨五入。72.55 → 72.6）で表示するときだけ丸め、計算・保存・CSV・JSONバックアップには丸める前の値を使う。食事の数量と基準量は丸めない（`numberText()`）。
- **体重の単位**：体重と目標体重は0.1kg単位で保存する（`saveWeight` / `saveGoal` が `roundTenth` で丸める。上限 999.9）。保存済みの0.01kg単位の値は書き換えず、`validateBackup` も0.01kg単位（上限 999.99）を受け付ける。
- **入力値の上限**：`app.js` 冒頭の定数 `LIMITS` が正本（食品の栄養値（基準量あたり・100gあたり）と1件の食事記録の計算後の値はカロリー 99,999.9 kcal／タンパク質・脂質・炭水化物 9,999.9 g（`calories` / `nutrient`）、1日の合計も同じカロリー 99,999.9 kcal／9,999.9 g（`dayCalories` / `dayNutrient`。`withinNutritionLimits(値, true)`）、数量・基準量 0.01〜9,999.99、食品名 1〜80文字（前後の空白を除く）、単位 1〜12文字、日付 2000-01-01〜2099-12-31、体重・目標体重 0.1〜999.9kg（復元は0.01kg単位・999.99まで）、復元できるファイルは50MBまで）。チェックは `foodValueError` / `amountError` / `withinNutritionLimits` / `dayTotalWithin` / `isValidDate`（日付の範囲）にまとめ、`saveFood`（編集時は紐づく記録と各日の合計を先に計算し、超えたら保存しない）・`saveQuickFood`・`addMeal`・`updateMealAmount`・`copyMeals`・`validateBackup` で使う。input 要素の min / max / maxlength も同じ値にするが、チェックは必ずJS側でも行う（フォームは novalidate）。上限を変えるときは `LIMITS` と input 要素の属性の両方を直す。CSV の文字の値は `csvCell` が数式扱いにならないよう先頭に `'` を付ける。
- **カードの配置と操作**：全体のルールは「今日・履歴のカードは、カードそのものは押しても何もしない。操作は目に見えるもの（数量入力、履歴の日付の行、右上の「⋯」）だけ」。食品マスターだけは管理用なので、カードを押すと編集が開く（例外）。削除の確認は「消えるのがその1件だけなら確認なし、ほかの記録も一緒に消えるなら確認あり」。右の列（操作ボタンの列）はどのカードにもなく、中身は全幅。栄養成分は共通の `.nutrient-grid` で、すべての画面・幅で2列。① 今日の食事カード：右上に「⋯」（`.more-button`、44×44px、aria-label「（食品名）の操作」、名前の右に余白）。マスターの記録の数量入力は左の「数量：[入力欄] 単位」の行（`.meal-amount-edit`。label なので「数量：」をタップしても入力欄にフォーカスする。入力欄は高さ31px・文字16px、横幅は6文字（999.99）が入る `calc(5.6ch + 12px)`。7文字は入力欄の中で横にずれる）。「⋯」のメニュー（`openMealMenu`）はマスターの記録＝削除、手入力の記録＝編集／削除。削除は確認なし（`deleteMeal`）、編集はメニューを閉じてから手入力の編集ダイアログを開く。② 履歴のカード：日付の行（›付き、高さ44px）が「その日を開く」`button.history-open`（押せる範囲は日付と「›」の幅だけで、その右の空いたところは押しても何もしない。aria-labelledby で日付・体重・栄養成分・PFCを読む）。体重・栄養成分・PFCは押しても何もしない。右上の「⋯」（aria-label「（日付）の操作」、Tab は日付の行→⋯）のメニュー（`openHistoryMenu`）は削除だけで、日付入りの確認のあとにその日の食事と体重を消す（`deleteHistoryDate`）。③ 食品マスターのカード：カードの右上に「›」（上下は名前の1行目の中心、左右は今日・履歴のカードの「⋯」の中心にそろえ、名前が何行でも動かない。名前の右に余白）、透明な `button.food-open` をカード全体に重ね、押すと `openFoodDialog` で編集が開く（aria-label「（食品名）を編集」）。削除は編集ダイアログの操作の行（`.modal-actions`）の左端の「削除」（`#food-delete`、aria-label「（食品名）を削除」、編集のときだけ表示。キャンセル・保存は右端のまま）で、紐づく記録の件数入りの確認のあとに `deleteFood` で消してダイアログを閉じる（キャンセルなら開いたまま）。④ 操作のメニュー：`index.html` の静的な `<dialog id="action-sheet">` を `openActionSheet({ title, detail, actions })` が `showModal()` で画面の下から開く（Popover API は使わない）。見出しは食品名と数量／日付と体重・カロリーで、文字は textContent で入れる。項目の間は1pxの線で、削除は赤い文字でほかの操作のあとに置き、いちばん下にキャンセル。最初のフォーカスは、キーボード（Enter・Space。click の `event.detail` が 0）で「⋯」を押して開いたときはキャンセル（枠を出す）、指・マウスで開いたときは dialog 自体（`tabindex="-1"`、枠なし）。どちらも「削除」には入れない（Enter の連打で消えないように）。背景・Esc・キャンセルで閉じ、開いている間は検索シートと同じ `lockSheetScroll` / `unlockSheetScroll` で後ろのページのスクロールを止める。操作を選ぶとメニューを閉じてから実行する（dialog を重ねない）。下の余白は `env(safe-area-inset-bottom)`（viewport に `viewport-fit=cover` あり）。カードの外の削除（食事をすべて削除、○年○月の記録を削除、食事と体重の記録をすべて削除、体重の削除）は従来どおり。⑤ 入力用のダイアログ（`#food-dialog`・`#quick-food-dialog`・`#copy-dialog`）も `showFormDialog(dialog, viaKeyboard)` で開き方を分ける：指・マウスで開いたとき（click の `event.detail` が 0 でない）は dialog 自体（`tabindex="-1"`、枠なし）にフォーカスを置き、入力欄にはフォーカスしない。キーボードで開いたときは showModal のまま最初の操作できる要素（「×」）に置く。メニューの「編集」から開くときは、メニューを開いたときの開き方に合わせる。「×」（`.icon-button`）はブラウザー標準の青い枠を出さず、`:focus-visible` のときだけ緑の枠。食品選択・成分表の検索シートのフォーカス（PCは検索欄、タッチ端末は一覧）はこれとは別。
- **ページの見出し**：ページ名は画面上のタブで分かるので、各ページの一番上にページ名の見出しを置かない（データ管理は「バックアップ」の枠から始め、食品マスターは見出し「食品マスター」と「＋ 食品を登録」を枠（`.card.foods-card`）の中の `.meal-top` に置き、すぐ下が検索欄。食品の入力の説明は登録ダイアログの中だけ）。例外は記録のページ（タブは「記録」）の日付の見出し（「2026/11/14(土)の記録」。`.day-heading`）で、どの日を見ているかを表すので残す。見出しの行は左右の中央（タイル2列の中央）、上の余白0、タイルとの間は10px。日付欄（白い枠の input）はなく、見出しそのもの（`.day-picker`。先頭に線だけのカレンダーのアイコン `.day-icon`：インラインの SVG、stroke="currentColor"・塗りなし、アプリのメインの緑（--green）、文字と同じくらいの大きさで上下の中央、文字との間6px、aria-hidden）を押すと日付を選べる：見えない `<input type="date" id="daily-date">`（opacity: 0、文字16px、読み上げ名「記録日」、aria-describedby で見出しの文字と、今日なら「今日」（`#day-today`）も読む）をアイコンを含めた見出し全体に重ねる（`showPicker()` は使わない。PC の Chrome 用にカレンダーの印を input 全体に広げる）。**iOS の日付ピッカーの動き**：① 日付を押した時点で change が起きる（✓ を押す前）、② 「リセット」は、ピッカーの表示は「ピッカーを開いたときの日付」に戻すが、input の値は defaultValue（value 属性）に戻す（バージョンによっては空になる場合もある）。表示と値がずれないよう、アプリ内のすべての `<input type="date">`（`#daily-date`・目標のダイアログの達成目標日・コピーのダイアログのコピー元の日付）は、ピッカーを開くとき（focus・pointerdown）に `keepDateResetOnOpen` が defaultValue をそのときの値にそろえる（リセットの戻り先が、表示も値も「開いたときの日付」になる。描き直しで作り直される `#daily-date` は描くたびに付ける）。これに合わせて、記録する日の切り替えは `applyDate` 1つにまとめ（値が空なら今日、範囲外ならトーストで元に戻す、今の日付と同じなら何もしない＝同じ値で2回描き直さない、それ以外は state.date を変えて描き直す）、タッチ操作の環境（`matchMedia("(hover: none), (pointer: coarse)")`）では blur（ピッカーを閉じて欄からフォーカスが外れたとき）で、マウス操作の環境では change（PC のピッカーは選ぶとすぐ閉じて blur が起きないため。値が空になったときの input も）で呼ぶ。`#daily-date` の value 属性は見ている日（state.date）。見出しの下に状態の行（`.day-status`、高さ14pxで固定）があり、今日なら小さな灰色の「今日」、ほかの日なら「今日に戻る」（`#back-to-today`、`.day-back`）を出す。どちらを出しても行の高さは同じなので、日付とタイルの位置は動かない。状態の行が日付の見出しのまとまりに見えるよう、日付の文字との間を狭く（見出しの h2 は line-height 1.1、日付の欄 `.day-picker` は文字の高さだけで min-height なし、状態の行の上は `--day-status-gap` 6px、360px未満は見出しが小さいので5px）、タイルとの間を広く（`--day-status-below` 16px）する。見た目の間隔は、日付の文字→状態の文字が約7〜8px、状態の文字→タイルが約17〜18px（上 < 下）。「今日に戻る」は戻る矢印のアイコン（線だけのインラインの SVG、1em 前後、aria-hidden）＋4px＋文字で、どちらも --green、背景・枠・下線なし、太さ700。押している間は少し薄くする（opacity .6）。押せる範囲は状態の行の2px上（`--day-back-up`）からタイルの上端まで（2 ＋ 行の高さ14 ＋ 16 ＝ 32px。文字の上には約2pxだけ広げ、下側のすき間に広げる。日付の欄との間は3〜4px空く）。負の margin で行の高さは変えず、上下の padding で文字を状態の行の真ん中に置く。日付の見出しにもタイルにも重ならない。日付の input の外に置き、`position: relative; z-index: 1`（押してもピッカーは開かない）。押すと state.date を今日にして描き直す。範囲外の日付は今までどおりトースト。押している間は見出し全体を少し薄くする（`.is-pressed`、opacity .6）。フォーカスの枠はキーボードで操作したときだけ見出しのまわりに出す（指・マウスで押したときは `.by-pointer` を付けて出さない）。中央寄せはアイコンを含めた全体で行う。長い見出しは折り返してよく、360px未満では見出しを少し小さくする。
- **体重グラフ**：素の SVG を手書きで生成する（ライブラリなし）。履歴のページを描いたあと `mountWeightChart(range, goalWeight)` が `#weight-chart` の実際の幅を測って `buildWeightChart` で描く（viewBox と表示の大きさが 1:1 なので、文字は 11px のまま。PC でも大きくならない）。幅が変わったら `ResizeObserver`（ない環境では resize）で描き直す。期間は、グラフの上の「いつから」「いつまで」の欄（`#chart-start`・`#chart-end`。選択欄と同じ見た目（枠＋▼）の button を横に2つ並べる。文字は年付き曜日付きの `dateLabel`（2026/11/14(土)）、いつまでが達成目標日なら「達成目標日」（日付は付けない）。文字の大きさは変えず、360px未満では余白・▼・字間を少し詰めて切れないようにする）で選ぶ。欄を押すと `openDateSheet(which, viaKeyboard)` が `index.html` の静的な `<dialog id="date-sheet">`（2つの欄で共通。見出し＋「×」）を画面の下から開く。日付は `chartChoiceDates`：いつから＝体重の記録がある日を古い順（いつまでより後は出さない）、いつまで＝記録がある日を新しい順（いつからより前・達成目標日と同じ日は出さない）。いつまでだけ、いちばん上に「達成目標日」（`chartTargetChoice`：達成目標日があり、いつから以降のときだけ）。日付は年月ごとの見出し「2026年11月」（年月だけで日数は出さない。`button.date-sheet-month`、aria-expanded / aria-controls）でたためて、初めは全部たたむ（年月が1つだけのとき・選んでいる日付の年月は開く）。選んでいる行には ✓（aria-pressed）。今の期間の日付に記録がないとき（v87 の「指定」など）もその日を一覧に入れて選んだ状態にする。行はどれも高さ44px以上。シートの高さは開いている間は固定する：開くときに `sizeDateSheet` が1回だけ「全部の年月を開いた状態」の中身の高さを測り、上限は画面の高さの75%（`DATE_SHEET_MAX_RATIO`。dvh がない古い iOS でも動くよう JS で測った `window.innerHeight` を使う。CSS の `max-height: 75vh` は JS が動く前の控え）。年月を開閉しても高さは変えず、閉じて空いたところはシートの下の余白になる。上限に届いたときは一覧の中だけスクロール。画面の高さが変わったとき（resize）は `applyDateSheetHeight` が上限だけ計算し直す。開くときに1回だけ `scrollDateSheetToSelected` が、選んでいる日付の行（年月の中の行。「達成目標日」の行は対象外）が一覧のいちばん上に来るようにスクロールする（下に行が足りないときは一番下まで。年月の開閉・resize では位置を直さない）。フォーカスとスクロールの止め方は「⋯」のメニューと同じ（`showFormDialog`・`lockSheetScroll` / `unlockSheetScroll`、背景・Esc・×で閉じる）。日付を選ぶと `applyChartDate` がシートを閉じ、いつから ≦ いつまで なら settings（`chartRangeMode: "manual"`・`chartStart`・`chartEnd`）に保存して描き直す（逆ならトーストを出して保存しない）。期間は `chartRange()` が決め、選んだ期間（正しい日付で、いつから ≦ いつまで）が使えなければ最初の記録の日〜最新の記録の日。目標体重 `goalWeight`・`targetDate`。左右の余白は同じ（46px）で、描く部分はカードの左右の真ん中。縦の目盛りは `niceWeightScale` が 0.1・0.2・0.5・1・2・5・10…kg から4〜6本になる区切りのいい間隔を選び、上下の端もその倍数にそろえる（下は0未満にしない。間隔1kg以上は整数、それより細かければ小数1桁）。縦軸の目盛りの数字の真上に「kg」（数字と右端をそろえる）、横軸の右の余白に「月/日」（日付と同じ高さ）。日付の文字が出ている位置にだけ、横の目盛りの線と同じ薄い縦線を引く。横軸の日付は `addDays`（ローカルの日付。UTC に変換しない）で、幅に合わせて2〜5個。期間が年をまたぐときは、最初と年が変わった日付に年を付ける。記録の線は点より薄い緑・2px（`CHART_LINE_COLOR`）、点は白いふちなしの半径3pxで、すべて同じ色（`CHART_DOT_COLOR`）。60個以上のときは点を描かず線だけにする。点（または24px以内の近く）をタップ・クリックすると、選んだ点を半径5px・白いふち付きにして、グラフの中に「11/14 72.5 kg」の吹き出し（`showChartTip`）を出し、グラフの外をタップすると消す（描き直すと消える）。傾向線（指数平滑）はなくした（記録した体重はいつも表示）。目標の線（`goalLineState`）：「いつまで」が達成目標日のときはいつも表示し、凡例の「目標」のボタンは表示中の見た目のまま aria-disabled（押すとトースト「いつまでが達成目標日のときは、目標の線を消せません。」）。それ以外のときは settings の `showGoalLine`（初期値 false）に従い、凡例の「目標 ○ kg」のボタンで `toggleGoalLine` が切り替えて保存する。凡例は線の印＋文字だけ（塗りつぶし・枠なし）で、印の色はグラフの線と同じ（記録した体重＝記録の線の緑、目標＝目標の線の色・点線）。「記録した体重」は黒い文字で切り替えない。「目標 ○ kg」は aria-pressed のボタン（押せる範囲は高さ44px）で、表示中は黒い文字と目標の色の点線、非表示は文字も印も薄い灰色。目標がないときはボタンを出さない。目標の線を表示しているときは、記録から遠くてもいつも縦の範囲に目標を含めて線を引き、表示していないときは範囲に含めない。（目標が範囲外のときに端へ「↑／↓」を出す扱いはなくした。）グラフの上には小さなカード3つ（`weightChartStats`。数値の下には何も書かず、高さはそろう）：「最新（11/14）」（最新の体重）、「先週比」（`weeklyChange`：保存されているすべての記録から、最新の記録の日を含む直近7日間（6日前〜その日）の体重の平均 − その前の7日間（13日前〜7日前）の平均。丸める前の値で計算し、表示だけ小数1桁。どちらかの7日間に記録がなければ「—」）、「目標まで」（「あと ○ kg」、届いたら緑で「達成」、目標がなければ「—」）。先週比の色：変化なし・よくない方向は薄い灰色（--muted）、よい方向は 濃さ ＝ |先週比| ÷ 基準のペース（0〜1）で灰色→「達成」と同じ緑（--green）になめらかに変える（`weeklyChangeColor`。基準より速くても同じ緑のまま）。基準のペース（`weeklyPaceBase`）は |最新の体重 − 目標| ÷ 今日から達成目標日までの週数で、目標・達成目標日がない、達成目標日が今日以前、目標を達成済みのときは週0.5kg、週0.1〜1.0kgに収める。よい方向と達成の判断は `goalDirection`：表示している期間に関係なく、保存されているすべての体重の記録のうちいちばん古い日の体重と目標を比べ、古い体重 > 目標なら減量、< 目標なら増量、同じなら最新が目標と同じときだけ達成。目標がないときは減ったときをよい方向とする。グラフの下の説明文に先週比の説明がある。
- **履歴のページ**：上から「体重の推移」のカード→「記録一覧」のカード。目標は独立したカードを持たず、体重の推移の見出しのすぐ下の行（`.goal-row`）に出す。行は「目標」「達成目標日」「ボタン」の3列のグリッド（`minmax(0,1fr) minmax(0,1.35fr) auto`）で、状態が変わっても列の位置・幅とボタンの位置は同じ。320px でも1行（3列）に収まる。「目標」「達成目標日」の列（`.goal-cell`）は、項目名（`.goal-label`、小さく --muted）を上、値（`.goal-value`）を下に並べる（「最新」「先週比」「目標まで」と同じ並べ方）。値は設定済みなら --ink の太字（「60.0 kg」、達成目標日は `goalDateText`：今年なら「3/31」、別の年は「2027/3/31」。曜日・残り日数・「まで」は付けない）、未設定なら「未設定」（`.goal-unset`、--muted の普通の太さ）。目標だけで達成目標日がないときも達成目標日は「未設定」。緑の文字は使わない。ボタン（`#open-goal`、button secondary small）は目標がないとき「設定」、あるとき「変更」で、右端の列の上下の中央。その下に「いつから」「いつまで」の選択欄。ボタンで `index.html` の静的な `#goal-dialog`（`#goal-form`）を `openGoalDialog` → `showFormDialog` で開く。操作の行は左端に「目標をクリア」（目標があるときだけ、danger）、右に「キャンセル」「保存」。開くとき `openGoalDialog` は、目標体重と達成目標日の欄の value と defaultValue を保存済みの値にする（達成目標日は、そのあとピッカーを開くたびに `keepDateResetOnOpen` がそのときの値にそろえる）。達成目標日の欄の右に「消す」（`#clear-target-date`、button secondary small。欄に日付があるときだけ表示、押すと欄だけを空にし、保存は「保存」のとき）。保存・クリアは `saveGoal` / `clearGoal`（入力のチェック・0.1kg単位への丸め・上限はそのまま）で、終わったらダイアログを閉じて描き直す。記録一覧の件数は「日分」で数える（見出しの右「全体 ○日分」、年月の見出しの下「○日分」）。データ管理のCSVのボタンは「記録一覧をCSVで書き出す」（中身は1日ごとの合計）。

## 開発時の効率化・確認ルール

### 1. 調査範囲

- 依頼された内容に関係するファイル・関数を優先して調査する。
- 毎回プロジェクト全体を読み直す必要はない。
- 既存の仕様や実装を把握できている場合、理由なく同じ調査を繰り返さない。
- ただし、変更の影響範囲が広い場合やデータの整合性に関わる場合は、必要な範囲を調査する。

### 2. 実装方針

- 依頼された機能・箇所以外は原則変更しない。
- 不要なリファクタリングやデザイン変更を行わない。
- 既存の機能・デザイン・データ構造との互換性を維持する。
- 問題が発生した場合、表面的な調整だけでなく原因を特定してから修正する。

### 3. テスト範囲

- 変更した機能と、その変更によって影響を受ける機能を中心に確認する。
- 無関係な機能のテストを毎回繰り返さない。
- IndexedDB、食事記録、バックアップ・復元など、既存データに影響する変更では必要な範囲を広く確認する。
- 実施していないテストを実施済みとして報告しない。

### 4. スマートフォン・iOSの確認

- スマートフォンの実機操作やiPhone実機での動作確認はユーザー自身が行う。
- 実機で確認できないことを、確認済みとして報告しない。
- 必要に応じてブラウザーの画面幅を変更し、スマートフォン相当のレイアウトを確認する。
- iOSネイティブ版のビルドや実機テストは、実行可能な環境がある場合のみ行う。
- 実機でしか確認できない項目は、ユーザーが確認できるよう簡潔に伝える。

### 5. 報告

作業完了後は、以下を簡潔に報告する。

- 変更したファイル
- 主な変更内容
- 実施したテストと結果
- 未確認事項や残っている問題
- 長い作業過程や、同じ内容の繰り返しは省略する。

### 6. 作業効率

- 必要以上に同じファイルを繰り返し読み込まない。
- 変更と無関係な調査・テストを行わない。
- トークン節約を意識しつつ、正確性やデータ保護に必要な調査・テストは省略しない。

### 7. プロジェクト情報の更新

- 開発の進行に伴い、新しい技術・ライブラリ・モデル・処理方式を導入した場合は、必要に応じてCLAUDE.mdのプロジェクト概要を更新する。
- 既存の技術や処理方式を変更・廃止した場合も、記載内容が実際の実装と一致するように更新する。
- 更新する際は、実際に導入・変更された内容だけを記載し、予定や検討段階の技術を実装済みとして記載しない。
- CLAUDE.mdの既存ルールやユーザーが管理している記述を、許可なく削除・変更しない。
- CLAUDE.mdを更新した場合は、変更内容を作業完了時に報告する。