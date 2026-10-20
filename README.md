# tiledcheck

[English](README.en.md)

檢查 Tiled 地圖（.tmx / .tmj）有沒有會在遊戲裡出事的問題：找不到的 tileset、圖片、模板，沒有 tileset 對得上的 gid，重複的物件 id，還有 Tiled 自己會默默丟掉的地形設定。可以在本機跑，也可以放進 CI。

```
$ tiledcheck maps/
maps/town.tmx: error: tileset (firstgid 1): ../tiles/town.tsx does not exist [missing-file]
maps/town.tmx: error: layer 'Ground': gid 97 is not in any tileset (12 tiles) [gid-out-of-range]
tiles/walls.tsx: error: tileset 'walls' terrain set 'Walls': 255 colors, Tiled 1.10.2+ supports 254 and silently drops every terrain set of this tileset [terrain-colors]
3 files checked, 3 errors, 0 warnings
```

## 使用

需要 Node.js 20 以上。

```sh
npx github:vtxe02023274/tiledcheck maps/
```

可以給地圖、tileset（.tsx / .tsj）或資料夾，資料夾會往下找所有地圖。有錯誤時結束碼是 1。

| 參數              | 作用                       |
| ----------------- | -------------------------- |
| `--json`          | 輸出 JSON                  |
| `--no-warnings`   | 只報錯誤                   |
| `--ignore <rule>` | 跳過某條規則，可以重複使用 |
| `--rules`         | 列出所有規則               |

放進 GitHub Actions：

```yaml
- uses: actions/setup-node@v5
  with:
    node-version: 22
- run: npx github:vtxe02023274/tiledcheck maps/
```

## 規則

| 規則                  | 等級 | 內容                                                          |
| --------------------- | ---- | ------------------------------------------------------------- |
| `load-error`          | 錯誤 | 檔案讀不了或格式壞了                                          |
| `missing-file`        | 錯誤 | 外部 tileset、圖片、圖層圖片或物件模板不存在                  |
| `gid-out-of-range`    | 錯誤 | 圖塊或物件的 gid 不在任何 tileset 範圍內（翻轉旗標會先去掉）  |
| `tileset-overlap`     | 錯誤 | 兩個 tileset 的 gid 範圍重疊                                  |
| `terrain-colors`      | 錯誤 | 地形組超過 254 色，Tiled 1.10.2 起整個 tileset 的地形都讀不到 |
| `layer-size`          | 錯誤 | 圖層的圖塊數跟寬×高對不上                                     |
| `tile-data`           | 錯誤 | 圖塊資料解不開（zstd 壓縮只會給警告，因為沒有檢查）           |
| `duplicate-object-id` | 錯誤 | 兩個物件用了同一個 id                                         |
| `next-object-id`      | 警告 | 物件 id 沒有小於地圖的 nextobjectid，Tiled 下次存檔可能重編   |
| `object-outside-map`  | 警告 | 物件整個在地圖外（只檢查正交、非無限地圖）                    |

支援 CSV、base64（無壓縮、zlib、gzip）、舊版 XML 圖塊資料、無限地圖的 chunk、群組圖層。舊檔案沒寫 `tilecount` 時，會照 Tiled 的算法從圖片尺寸推算；推不出來就延伸到下一個 tileset 的 firstgid。

用 Tiled 原始碼裡的 22 張範例地圖測過，TMX 原檔和用 Tiled 轉出的 JSON 版結果一致，沒有誤報（只有 2 個物件確實在地圖外的警告）。

## 開發

```sh
npm install
npm test
npm run lint
npm run build   # 輸出 dist/
```

## 授權

MIT
