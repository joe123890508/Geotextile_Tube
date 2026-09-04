    const filePaths = { taiwan: 'https://joe123890508.github.io/Geotextile_Tube/taiwan.geojson', 
                        basin: 'https://joe123890508.github.io/Geotextile_Tube/basin.geojson', 
                        stations: 'https://joe123890508.github.io/Geotextile_Tube/water_level_sta.geojson' };
    const apiUrl = "https://opendata.wra.gov.tw/api/v2/73c4c3de-4045-4765-abeb-89f9f9cd5ff0?sort=_importdate%20asc&format=JSON";
    let geoData = { taiwan: null, basin: null, stations: null };
    let basinAlertLevels = {}; // 紀錄集水區的警戒狀態
    let apiWaterData = {}; // 紀錄即時水位數值
    let globalProject = null;
    let defaultViewBox = "0 0 800 600";
    const basinSelect = document.getElementById('basin-select');
    const stationSelect = document.getElementById('station-select');
    const tooltip = document.getElementById('basin-tooltip');
    const mapContainer = document.getElementById('map-container');
    const PUSH_PLATFORMS = [{id: 'line', name: 'Line', refreshFn: () => renderLinePushList()},
                            {id: 'discord', name: 'Discord', refreshFn: () => renderDiscordPushList()}];
    function bindActionEvents(inputEl, btnEl, handler) {
      btnEl.addEventListener('click', handler);
      inputEl.addEventListener('keypress', (e) => { if (e.key === 'Enter') handler(); });
    }
    function buildSvgPoints(coords) {
      return coords.map(coord => {
        const [x, y] = globalProject(coord[0], coord[1]);
        return `${x},${y}`;
      }).join(' L ');
    }
    // 啟動函式
    async function initApp() {
      try {
          geoData = await WaterDataService.loadGeoJsonData();
          let rawApiWaterData = await WaterDataService.fetchWaterLevels() // 初始化水位數值
          apiWaterData = rawApiWaterData.data;
          document.getElementById('update-time').innerHTML = rawApiWaterData.updateTime ? rawApiWaterData.updateTime.slice(5) : '未更新成功'
          evaluateBasinAlertLevels();
          renderMap();
          updateDropdowns();
          renderLinePushList(); // 初始化Line推播清單列表
          renderDiscordPushList(); // 初始化Discord推播清單列表
          startTimer(); // 水位更新計時器
          window.addEventListener('resize', renderMap);
        } catch (err) { console.error("資料載入失敗:", err); }
    }
    window.addEventListener('DOMContentLoaded', initApp);
    // 負責 GeoJSON 與即時 API 資料的存取與清洗的物件
    const WaterDataService = {
      config: { filePaths, apiUrl},
      // 私有狀態快取
      _geoData: { taiwan: null, basin: null, stations: null },  _waterLevels: {},
      // 取得快取資料的 Getter
      get geoData() { return this._geoData; },
      get waterLevels() { return this._waterLevels; },
      // 載入地圖資料
      async loadGeoJsonData() {
        try {
          const [taiwanRes, basinRes, stationsRes] = await Promise.allSettled(
            [ fetch(this.config.filePaths.taiwan).then(res => res.json()),
              fetch(this.config.filePaths.basin).then(res => res.json()),
              fetch(this.config.filePaths.stations).then(res => res.json()), ]);
          if (taiwanRes.status === 'fulfilled') this._geoData.taiwan = taiwanRes.value;
          if (basinRes.status === 'fulfilled') this._geoData.basin = basinRes.value;
          if (stationsRes.status === 'fulfilled') this._geoData.stations = stationsRes.value;
        } catch (err) { console.error("GeoJSON 資料載入失敗:", err); }
        return this._geoData;
      },
      // 更新與清洗水位資料
      async fetchWaterLevels() {
        this._waterLevels = { data: {}, updateTime: new Date().toLocaleString() };
        try {
          const list = await fetch(this.config.apiUrl).then(res => res.json());
          let data = (Array.isArray(list) ? list : []).reduce((acc, { stationid, waterlevel }) => {
            const num = Number(waterlevel);
            acc[stationid] = (!isNaN(num) && waterlevel !== "" && waterlevel != null) ? Math.round(num * 100) / 100 : (waterlevel ?? "無資料");
            return acc;
          }, {});
          this._waterLevels = { data, updateTime: new Date().toLocaleString()};
        } catch (err) { console.error("即時水位資料更新失敗:", err); }
        return this._waterLevels;
      }
    };
    // 在 WaterDataService 內部擴充屬性解析與查詢工具方法
    Object.assign(WaterDataService, {
      getStationId(feature) { return feature?.properties?.ST_NO || ""; },
      getStationName(feature) { return feature?.properties?.NAME_C || "未命名測站"; },
      getStationBasin(feature) { return feature?.properties?.BASIN_NAME || "未知集水區"; },
      parseAlertLevels(props) {
        const parseVal = (val) => (val !== null && val !== undefined && val !== "") ? Number(val) : NaN;
        return {alert1: parseVal(props?.alert_level_1),
                alert2: parseVal(props?.alert_level_2),
                alert3: parseVal(props?.alert_level_3)};
      },
      // 取得單一測站的完整打包資訊 (給UI選取時直接使用)
      getStationDetails(feature) {
        const props = feature?.properties || {};
        const id = this.getStationId(feature);
        const name = this.getStationName(feature);
        const basin = this.getStationBasin(feature);
        const level = this._waterLevels.data ? this._waterLevels.data[id] : undefined;
        const { alert1, alert2, alert3 } = this.parseAlertLevels(feature.properties);
        return {id, name, basin, level, alert1, alert2, alert3,
                a1: !isNaN(alert1) ? alert1 : undefined,
                a2: !isNaN(alert2) ? alert2 : undefined,
                a3: !isNaN(alert3) ? alert3 : undefined,
                camera_sta: props.camera_sta || null,
                camera_id: props.camera_id || null,
                camera_sourceid: props.camera_sourceid || null,};
      }
    });
    // 定期更新水位資料
    function startTimer() {
      const workerCode = `
        let timer = null;
        self.onmessage = function(e) {
          if (e.data === 'start') {
            // 設定每 10 分鐘 (10 * 60 * 1000 = 600,000 毫秒) 觸發
            timer = setInterval(() => {
              self.postMessage('TICK');
            }, 600000);
          } else if (e.data === 'stop') {
            clearInterval(timer);
          }
        };
      `;
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const worker = new Worker(URL.createObjectURL(blob)); // 動態載入 Worker
      // 監聽 Worker 傳回的訊號
      worker.onmessage = async function(e) {
        if (e.data === 'TICK') {
          let rawApiWaterData = await WaterDataService.fetchWaterLevels() // 初始化水位數值
          apiWaterData = rawApiWaterData.data;
          document.getElementById('update-time').innerHTML = rawApiWaterData.updateTime ? rawApiWaterData.updateTime.slice(5) : '未更新成功'
          evaluateBasinAlertLevels();
          renderMap();
        }
      };
      worker.postMessage('start'); // 啟動排程
    }
    // 通用 Token/Webhook Header 渲染模組
    function renderPlatformHeaderConfig({ platform, onSuccess }) {
      const sessionKey = platform.charAt(0).toUpperCase() + platform.slice(1) + '_Channel_Token'
      const labelTitle = '請輸入 ' + platform.charAt(0).toUpperCase() + platform.slice(1) + ' Channel Token' + '：'
      const container = document.getElementById(platform + '-channel-container');
      if (!container) return;
      const savedValue = sessionStorage.getItem(sessionKey) || '';
      let inputEl = container.querySelector(`#${sessionKey}`);
      if (!inputEl) {
        const wrapper = document.createElement('div');
        wrapper.className = 'input-group';
        wrapper.innerHTML = ` <span class="input-group-text">${labelTitle}</span>
                              <input type="text" class="form-control" placeholder="${savedValue || sessionKey}" id="${sessionKey}">
                              <button class="btn btn-outline-secondary confirm-btn" type="button">確認</button> `;
        const confirmBtn = wrapper.querySelector('.confirm-btn');
        inputEl = wrapper.querySelector(`#${sessionKey}`);
        confirmBtn.addEventListener('click', () => {
          const val = inputEl.value.trim();
          if (!val) { alert('請檢查輸入內容'); return; }
          try {
            sessionStorage.setItem(sessionKey, val);
            inputEl.placeholder = val;
            inputEl.value = '';
            if (typeof onSuccess === 'function') onSuccess();
            alert('已成功儲存！');
          } catch (err) { alert('儲存失敗！'); }
        });
        container.appendChild(wrapper);
      } else { inputEl.placeholder = savedValue || sessionKey; } // 已存在時僅更新顯示內容
    }
    // sessionStorage 快取管理器
    class CacheManager {
      constructor(dataKey, timeKey, expireMs = 60 * 60 * 1000) {
        this.dataKey = dataKey;
        this.timeKey = timeKey;
        this.expireMs = expireMs;
      }
      get() {
        const cachedData = sessionStorage.getItem(this.dataKey);
        const cachedTime = sessionStorage.getItem(this.timeKey);
        const now = Date.now();
        if (cachedData && cachedTime && now - Number(cachedTime) < this.expireMs) {
          try { return JSON.parse(cachedData); }
          catch (e) { this.clear(); }
        }
        return null;
      }
      set(data) {
        sessionStorage.setItem(this.dataKey, JSON.stringify(data));
        sessionStorage.setItem(this.timeKey, Date.now().toString());
      }
      clear() {
        sessionStorage.removeItem(this.dataKey);
        sessionStorage.removeItem(this.timeKey);
      }
    }
    // 站點圖資轉換服務
    const StationMapService = {
      // 根據傳入的 geoData 建立 ST_NO -> NAME 的對照字典
      _buildNameMap(geoData) {
        const map = {};
        const features = geoData?.features;
        if (Array.isArray(features)) {
          features.forEach((feature) => {
            const stNo = WaterDataService.getStationId(feature);
            const stName = WaterDataService.getStationName(feature);
            if (stNo) map[stNo] = stName;
          });
        }
        return map;
      },
      // 補全 platformData 中缺失的站點名稱NAME_C
      enrichStationNames(platformData, geoData) {
        const nameMap = this._buildNameMap(geoData);
        const enriched = { ...platformData };
        Object.keys(enriched).forEach((stNo) => {
          if (enriched[stNo]) { enriched[stNo].name = enriched[stNo].name || nameMap[stNo] || "未知測站"; }
        });
        return enriched;
      }
    };
    // Flask 後端請求配置表：定義動作名稱、驗證規則與參數映射
    const ACTION_CONFIGS = {
      addStation: { action: 'add_station', mapParams: (stationName) => ({ station_name: stationName }) },
      deleteStation: { action: 'delete_station', mapParams: () => ({}) },
      updateAlertLevel: { action: 'update_limit', mapParams: (rawValue) => ({ limit: rawValue?.toString().trim() }),
        validate: (rawValue) => {
          const val = rawValue?.toString().trim();
          return (!val || isNaN(val)) ? "請輸入有效的數字！" : null;
        }
      },
      addTarget: { action: 'add_target', mapParams: (rawValue) => ({ target: rawValue?.toString().trim() }),
        validate: (rawValue, targetLabel = '發送對象') => {
          const val = rawValue?.toString().trim();
          return !val ? `請輸入有效的 ${targetLabel}！` : null;
        }
      },
      deleteTarget: { action: 'delete_target', mapParams: (target) => ({ target }) }
    };
    // 動態生成呼叫 Flask 後端方法
    function createServiceMethods(configs, requestSender) {
      const methods = {};
      Object.entries(configs).forEach(([methodName, config]) => {
        methods[methodName] = async function (platform, stationId, ...args) {
          // 執行驗證（若有）
          if (config.validate) {
            const errorMsg = config.validate(...args);
            if (errorMsg) return { success: false, message: errorMsg };
          }
          // 組裝 FormData
          const fd = new FormData();
          fd.append('platform', platform);
          fd.append('action', config.action);
          fd.append('station_id', stationId);
          // 映射其他參數
          const params = config.mapParams ? config.mapParams(...args) : {};
          Object.entries(params).forEach(([k, v]) => fd.append(k, v));
          const res = await requestSender.call(this, fd); // 發送請求
          return res; // 回傳發送結果
        };
      });
      return methods;
    }
    // 呼叫後端 API 抽象函式
    const pushListServiceAbstract = {
      cache: new CacheManager('cache_all_push_list', 'cache_all_push_list_time'),
      _getCsrfToken() { return document.querySelector('meta[name="csrf-token"]')?.content 
                               || window.parent.document.querySelector('meta[name="csrf-token"]')?.content; },
      clearAllCache() { this.cache.clear(); }, // 清除快取公開介面
      async sendRequest(formData) {
        try {
          const csrfToken = this._getCsrfToken();
          const data = Object.fromEntries(formData.entries()); // 將 FormData 轉為一般 JSON 物件
          response = window.parent.postMessage({ type: 'SUBMIT_WATER_CONFIG', payload: data}, '*'); // 透過 postMessage 傳送給 Parent 頁面
          const resData = await response.json();
          if (resData.status === 'success') {
            this.cache.clear();
            return { success: true, message: resData.message };
          }
          return { success: false, message: resData.message || '操作失敗' };
        } 
        catch (e) { return { success: false, message: `連線失敗: ${e.message}` }; }
      },
      // 取得指定平台的推播設定檔
      async getAsync(platform, GeoData = geoData.stations) {
        let allData = this.cache.get();
        if (!allData) {
          try {
            // 通知 Parent 頁面：我想取得水位設定資料
            window.parent.postMessage({ type: 'GET_WATER_CONFIG' }, '*');
            const resData = await response.json();
            if (resData.status === 'success') { allData = resData.data || {};
                                                this.cache.set(allData); }
            else { throw new Error(resData.message || "取得全資料失敗"); }
          }
          catch (e) { allData = {}; }
        }
        const platformData = allData[platform] || {};
        return StationMapService.enrichStationNames(platformData, GeoData);
      },
      // 執行連結後端的actionApiFn
      async execute(actionApiFn, onSuccess) {
        const res = await actionApiFn();
        alert(res.message);
        if (res.success && typeof onSuccess === 'function') { onSuccess(res); }
        return res;
      },
    }
    const dynamicMethods = createServiceMethods(ACTION_CONFIGS, function (fd) { return this.sendRequest(fd); }); // 動態擴充
    const pushListService = Object.assign(pushListServiceAbstract, dynamicMethods); // pushListService 物件實體化
    // 快速生成 HTML 元素與綁定事件的工廠函式
    function el(tag, props = {}, children = []) {
      const element = document.createElement(tag);
      Object.keys(props).forEach(key => {
        if (key.startsWith('on') && typeof props[key] === 'function') { element.addEventListener(key.substring(2).toLowerCase(), props[key]);} // 自動綁定事件
        else if (key === 'className') { element.className = props[key];}
        else if (key === 'style' && typeof props[key] === 'object') { Object.assign(element.style, props[key]); }
        else { element.setAttribute(key, props[key]); }
      });
      const childrenArray = Array.isArray(children) ? children : [children];
      childrenArray.forEach(child => {
        if (child === null || child === undefined) return;
        if (typeof child === 'string' || typeof child === 'number') { element.appendChild(document.createTextNode(child)); }
        else if (child instanceof Node) { element.appendChild(child); }
      });
      return element;
    }
    // LINE 卡片標題列特有控制組件
    function createLineHeaderControls(count) {
      return [el('span', { className: 'badge bg-primary-subtle text-primary border border-primary-subtle px-2 py-1' }, `${count} 個推播對象`),
              el('span', { className: 'text-secondary small arrow-icon transition-transform' }, '▼')];
    }
    // Discord 卡片標題列特有控制組件
    function createDiscordHeaderControls(onConfirmLevel) {
      const levelInput = el('input', { type: 'number', min: '0', className: 'form-control level-input py-0', placeholder: 'water_level' });
      const levelBtn = el('button', { className: 'btn btn-outline-secondary confirm-level-btn py-0', type: 'button' }, '修改');
      bindActionEvents(levelInput, levelBtn, () => onConfirmLevel(levelInput.value));
      return el('div', { className: 'input-group input-group-sm py-0' }, [ el('span', { className: 'input-group-text py-0' }, '更改警戒水位：'), levelInput, levelBtn ]);
    }
    // 卡片標題列 View 組件
    function createCardHeader({ item, index, traggetList, platform, content, refreshCallback, onDeleteStation }) {
      function onToggle() {
        const isShown = content.classList.toggle('d-none') === false;
        const arrow = header.querySelector('.arrow-icon');
        if (arrow) arrow.style.transform = isShown ? 'rotate(180deg)' : 'rotate(0deg)';
      }
      const deleteBtn = el('button', { type: 'button', className: 'btn btn-sm btn-outline-danger py-0 px-1 text-nowrap',
                            onClick: (e) => { e.stopPropagation(); onDeleteStation(); } }, '刪除');
      const headerLeft = el('div', { className: 'd-flex align-items-center gap-2' }, 
        [ el('span', { className: 'badge bg-secondary-subtle text-secondary font-monospace border' }, index + 1),
          el('span', { className: 'fw-bold text-dark fs-6' }, item.name),
          el('span', { className: 'badge bg-danger text-white border border-danger-subtle px-2 py-1' }, `警戒水位：${item.limit || '未設定'}`) ]);
      const headerRightChildren = [];
      if (platform === 'line') {
        const [badgeEl, arrowEl] = createLineHeaderControls(traggetList.length);
        headerRightChildren.push(badgeEl, deleteBtn, arrowEl);
      } else if (platform === 'discord') {
        const onConfirmLevel = (val) => { pushListService.execute(
          () => pushListService.updateAlertLevel(platform, item.id, val), refreshCallback);
        };
        headerRightChildren.push(createDiscordHeaderControls(onConfirmLevel), deleteBtn);
      }
      const headerRight = el('div', { className: 'd-flex align-items-center gap-2' }, headerRightChildren);
      const headerProps = { style: { cursor: 'pointer' },
                            className: 'card-header bg-light text-dark border-secondary-subtle p-2 px-3 d-flex align-items-center justify-content-between user-select-none' };
      if (platform === 'line') { headerProps.onClick = onToggle; }
      const header = el('div', headerProps, [headerLeft, headerRight]);
      return header;
    }
    // 渲染已存在的 tragget 列表
    function createTargetListView(traggetList, targetLabel, onDeleteUser) {
      if (traggetList.length === 0) { return el('div', { className: 'text-secondary small p-1 text-center' }, `尚無推播目標 (${targetLabel})`); }
      const items = traggetList.map(t => 
        el('div', { className: 'd-flex align-items-center justify-content-between p-2 bg-body-secondary border border-light-subtle rounded text-dark small' },
        [ el('span', {}, t),
          el('button', { type: 'button', className: 'btn btn-sm btn-outline-warning py-0 px-1', onClick: () => onDeleteUser(t) }, '刪除') ])
      );
      return el('div', { className: 'vstack gap-1' }, items);
    }
    // 渲染輸入控制組件 (修改水位與加入目標)
    function createInputControls({ targetLabel, onConfirmLevel, onConfirmTarget }) {
      const levelInput = el('input', { type: 'text', className: 'form-control level-input', placeholder: 'water_level' });
      const levelBtn = el('button', { className: 'btn btn-outline-secondary', type: 'button' }, '修改');
      bindActionEvents(levelInput, levelBtn, () => onConfirmLevel(levelInput.value));
      const targetInput = el('input', { type: 'text', className: 'form-control target-input', placeholder: targetLabel });
      const targetBtn = el('button', { className: 'btn btn-outline-secondary', type: 'button' }, '加入');
      bindActionEvents(targetInput, targetBtn, () => onConfirmTarget(targetInput.value));
      return el('div', { className: 'gap-2 flex-row d-flex' }, [
        el('div', { className: 'input-group input-group-sm flex-fill' }, 
          [ el('span', { className: 'input-group-text' }, '更改警戒水位：'), levelInput, levelBtn ]),
        el('div', { className: 'input-group input-group-sm flex-fill' }, 
          [ el('span', { className: 'input-group-text' }, `加入${targetLabel}：`), targetInput, targetBtn ])
      ]);
    }
    // 建立單一站點卡片組件
    function createStationCard({ stationId, item, index, targetLabel, isOpen, context, platform }) {
      const { storageKey, openStationIds, refreshCallback } = context;
      const traggetList = Array.isArray(item.tragget) ? item.tragget : [];
      // 卡片展開內容區 (僅 LINE 顯示)
      const content = el('div', { className: `card-body bg-white border-top border-secondary-subtle p-2 ${isOpen ? '' : 'd-none'} vstack gap-2` });
      const header = createCardHeader({ item, index, traggetList, platform, content, refreshCallback,
                                        onDeleteStation: () => { pushListService.execute(
                                          () => pushListService.deleteStation(platform, stationId, item.name), refreshCallback)} });
      if (platform === 'line') {
        if (isOpen) {
          const arrow = header.querySelector('.arrow-icon');
          if (arrow) arrow.style.transform = 'rotate(180deg)';
        }
        const targetListView = createTargetListView(traggetList, targetLabel, (target) => { pushListService.execute(
                                                      () => pushListService.deleteTarget(platform, stationId, target), refreshCallback) });
        const inputControls = createInputControls({ targetLabel,
          onConfirmLevel: (val) => { pushListService.execute(
            () => pushListService.updateAlertLevel(platform, stationId, val), refreshCallback)},
          onConfirmTarget: (val) => { pushListService.execute(
            () => pushListService.addTarget(platform, stationId, val, targetLabel), refreshCallback)}
        });
        content.appendChild(targetListView);
        content.appendChild(inputControls);
      }
      return el('div', { className: 'card bg-white border border-secondary-subtle shadow-sm overflow-hidden flex-shrink-0', 'data-station-id': stationId },
                [ header, platform === 'line' ? content : null ]);
    }
    // 收集當前打開的站點 ID
    function getOpenStationIds(container) {
      const openStationIds = new Set();
      container.querySelectorAll('.card').forEach(cardEl => {
        const contentEl = cardEl.querySelector('.card-body');
        if (contentEl && !contentEl.classList.contains('d-none')) {
          const sid = cardEl.getAttribute('data-station-id');
          if (sid) openStationIds.add(sid);
        }
      });
      return openStationIds;
    }
    async function renderPushListUI({ platform, refreshCallback }) {
      const containerId = `push-${platform}-list-container`;
      const targetLabel = platform === 'line' ? 'Line User ID' : 'Discord 標註/對象';
      const container = document.getElementById(containerId);
      if (!container) return;
      const openStationIds = getOpenStationIds(container);
      container.innerHTML = `<div class="text-secondary text-center my-auto pt-3">資料載入中...</div>`;
      let pushList = await pushListService.getAsync(platform);
      const keys = Object.keys(pushList);
      container.innerHTML = '';
      if (keys.length === 0) {
        container.innerHTML = `<div class="text-secondary text-center my-auto pt-3">目前尚未加入任何推播水位站</div>`;
        return;
      }
      const context = { platform, openStationIds, refreshCallback };
      keys.forEach((stationId, index) => {
        const itemData = { id: stationId, ...pushList[stationId] };
        const card = createStationCard({ stationId, item: itemData, index, targetLabel, isOpen: openStationIds.has(stationId), context, platform });
        container.appendChild(card);
      });
    }
    function renderLinePushList() { renderPushListUI({ platform:'line', refreshCallback: renderLinePushList }); } // Line 渲染
    function renderDiscordPushList() { renderPushListUI({ platform:'discord', refreshCallback: renderDiscordPushList }); } // Discord 渲染
    // 評估集水區警戒狀態
    function evaluateBasinAlertLevels() {
      if (!geoData.stations || !geoData.stations.features) return;
      basinAlertLevels = {};
      geoData.stations.features.forEach(feature => {
        const basin = WaterDataService.getStationBasin(feature);
        const id = WaterDataService.getStationId(feature);
        const currentLevel = apiWaterData[id];
        const { alert1, alert2, alert3 } = WaterDataService.parseAlertLevels(feature.properties);
        if (isNaN(alert1) && isNaN(alert2) && isNaN(alert3)) return;
        if (!basin || typeof currentLevel !== 'number' || isNaN(currentLevel)) return;
        let currentStatus = basinAlertLevels[basin] || 'normal';
        if (!isNaN(alert1) && currentLevel >= alert1) {
          currentStatus = 'red';
        } else if (!isNaN(alert2) && currentLevel >= alert2) {
          currentStatus = 'orange';
        } else if (!isNaN(alert3) && currentLevel >= alert3) {
          currentStatus = 'yellow';
        }
        basinAlertLevels[basin] = currentStatus;
      });
    }
    // 地圖投影計算模組
    const MapProjection = {
      update(svgEl, taiwanFeature, container) {
        const padding = 30;
        const svgWidth = container.clientWidth || 800;
        const svgHeight = container.clientHeight || 600;
        defaultViewBox = `0 0 ${svgWidth} ${svgHeight}`;
        svgEl.setAttribute("viewBox", defaultViewBox);
        const coordinates = taiwanFeature.geometry.coordinates[0];
        const location = { lons: coordinates.map(c => c[0]), lats: coordinates.map(c => c[1]) }
        const minLon = Math.min(...location['lons']), maxLon = Math.max(...location['lons']);
        const minLat = Math.min(...location['lats']), maxLat = Math.max(...location['lats']);
        const Range = { lon: maxLon - minLon, lat: maxLat - minLat}
        const availableWidth = svgWidth - padding * 2;
        const availableHeight = svgHeight - padding * 2;
        const scale = Math.min(availableWidth / Range['lon'], availableHeight / Range['lat']);
        const xOffset = padding + (availableWidth - Range['lon'] * scale) / 2;
        const yOffset = padding + (availableHeight - Range['lat'] * scale) / 2;
        globalProject = function project(lon, lat) {
          const x = xOffset + (lon - minLon) * scale;
          const y = yOffset + (maxLat - lat) * scale;
          return [x, y];
        };
        return coordinates;
      }
    };
    // 繪製台灣輪廓圖層
    function renderTaiwanBoundary(svgEl, coordinates) {
      const taiwanPointsStr = buildSvgPoints(coordinates);
      const taiwanPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
      taiwanPath.setAttribute("d", `M ${taiwanPointsStr} Z`);
      taiwanPath.setAttribute("class", "taiwan-land");
      svgEl.appendChild(taiwanPath);
    }
    // 繪製集水區圖層
    function renderBasins(svgEl, basinData) {
      if (!basinData) return;
      const gBasin = document.createElementNS("http://www.w3.org/2000/svg", "g");
      basinData.features.forEach(feature => {
        const geom = feature.geometry;
        const basinName = feature.properties.BASIN_NAME || feature.properties.BasinName || "集水區";
        const polygons = geom.type === "Polygon" ? [geom.coordinates] : (geom.type === "MultiPolygon" ? geom.coordinates : []);
        const alertStatus = basinAlertLevels[basinName] || 'normal';
        let alertClass = '';
        if (alertStatus === 'red') alertClass = 'alert-red';
        else if (alertStatus === 'orange') alertClass = 'alert-orange';
        else if (alertStatus === 'yellow') alertClass = 'alert-yellow';
        polygons.forEach(polygonCoords => {
          const pointsStr = buildSvgPoints(polygonCoords[0]);
          const bPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
          bPath.setAttribute("d", `M ${pointsStr} Z`);
          bPath.setAttribute("class", `basin-land ${alertClass}`);
          bPath.setAttribute("data-basin-name", basinName);
          bPath.addEventListener('mousemove', (e) => {
            const rect = mapContainer.getBoundingClientRect();
            tooltip.style.left = `${e.clientX - rect.left}px`;
            tooltip.style.top = `${e.clientY - rect.top}px`;
            tooltip.innerText = `${basinName}`;
            tooltip.classList.remove('d-none');
            tooltip.style.display = 'block';
          });
          bPath.addEventListener('mouseleave', () => { 
            tooltip.classList.add('d-none');
            tooltip.style.display = 'none'; 
          });
          bPath.addEventListener('click', () => {
            if (basinSelect.value !== basinName) {
              basinSelect.value = basinName;
              basinSelect.dispatchEvent(new Event('change'));
            }
          });
          gBasin.appendChild(bPath);
        });
      });
      svgEl.appendChild(gBasin);
    }
    // 繪製水位測站節點圖層
    function renderStationNodes(svgEl, stationData) {
      if (!stationData) return;
      const gStations = document.createElementNS("http://www.w3.org/2000/svg", "g");
      stationData.features.forEach(feature => {
        const coords = feature.geometry.coordinates;
        const [cx, cy] = globalProject(coords[0], coords[1]);
        const id = WaterDataService.getStationId(feature);
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", cx);
        circle.setAttribute("cy", cy);
        circle.setAttribute("r", 3);
        circle.setAttribute("id", `station-dot-${id}`);
        circle.setAttribute("class", "station-node");
        circle.addEventListener('click', (e) => {
          e.stopPropagation();
          selectStation(feature);
        });
        circle.addEventListener('mousemove', (e) => {
          const rect = mapContainer.getBoundingClientRect();
          tooltip.style.left = `${e.clientX - rect.left}px`;
          tooltip.style.top = `${e.clientY - rect.top}px`;
          tooltip.innerText = `水位站：${WaterDataService.getStationName(feature)}`;
          tooltip.classList.remove('d-none');
          tooltip.style.display = 'block';
        });
        circle.addEventListener('mouseleave', () => {
          tooltip.classList.add('d-none');
          tooltip.style.display = 'none';
        });
        gStations.appendChild(circle);
      });
      svgEl.appendChild(gStations);
    }
    // 主地圖調度繪製器
    function renderMap() {
      const svgEl = document.getElementById('taiwan-svg');
      if (!svgEl || !geoData.taiwan) return;
      svgEl.innerHTML = ''; // 清空畫布
      const coordinates = MapProjection.update(svgEl, geoData.taiwan.features[0], mapContainer); // 更新投影演算法並取得幾何座標
      renderTaiwanBoundary(svgEl, coordinates);
      renderBasins(svgEl, geoData.basin);
      renderStationNodes(svgEl, geoData.stations);
    }
    function updateDropdowns() {
      if (!geoData.stations) return;
      const basins = new Set();
      geoData.stations.features.forEach(f => {
        const bName = WaterDataService.getStationBasin(f);
        if (bName) basins.add(bName);
      });
      basinSelect.innerHTML = '<option value="" class="text-center">-- 請選擇集水區 --</option>';
      basins.forEach(b => {
        basinSelect.innerHTML += `<option value="${b}" class="text-center">${b}</option>`;
      });
      basinSelect.disabled = false;
    }
    stationSelect.addEventListener('change', (e) => {
      const selectedId = e.target.value;
      if (!selectedId) return;
      const targetFeature = geoData.stations.features.find(f => WaterDataService.getStationId(f) === selectedId);
      if (targetFeature) { selectStation(targetFeature); }
    });
    // 根據水位與警戒等級更新燈號 UI
    function updateStationStatusUI(level, alert1, alert2, alert3) {
      const statusTextEl = document.getElementById("status-text");
      const statusLightEl = document.getElementById("status-light");
      if (!statusTextEl || !statusLightEl) return;
      let statusText, lightClass, textColor;
      switch (true) { case Number.isFinite(alert1) && level >= alert1:
                        statusText = "一級警戒"; lightClass = "light-warning-1"; textColor = "#dc3545"; break;
                      case Number.isFinite(alert2) && level >= alert2:
                        statusText = "二級警戒"; lightClass = "light-warning-2"; textColor = "#fd7e14"; break;
                      case Number.isFinite(alert3) && level >= alert3:
                        statusText = "三級警戒"; lightClass = "light-warning-3"; textColor = "#f57f17"; break;
                      default:
                        statusText = "正常水位"; lightClass = "light-normal"; textColor = "#198754"; break; }
      statusTextEl.textContent = statusText;
      statusTextEl.style.color = textColor;
      statusLightEl.className = `status-light rounded-circle flex-shrink-0 ${lightClass}`;
    }
    // 負責高亮與標記選中的測站節點
    function highlightStation(id) {
      stationSelect.value = id;
      document.querySelectorAll('.station-node').forEach(el => el.classList.remove('selected'));
      const activeDot = document.getElementById(`station-dot-${id}`);
      if (activeDot) activeDot.classList.add('selected');
    }
    // 清空水位色塊儀表條
    function clearStationSelection() {
      const statusTextEl = document.getElementById('status-text');
      const statusLightEl = document.getElementById('status-light');
      const gaugeContainer = document.getElementById('gauge-container');
      if (statusTextEl) {
        statusTextEl.textContent = "";
        statusTextEl.style.color = "#6c757d";
      }
      if (statusLightEl) { statusLightEl.className = "status-light rounded-circle flex-shrink-0"; }
      if (gaugeContainer) { gaugeContainer.style.display = "none"; }
    }
    // 動態計算並渲染水位軸線與刻度指針
    function renderGaugeBar(currentLevel, a3, a2, a1) {
      const gaugeContainer = document.getElementById("gauge-container");
      const pointerEl = document.getElementById("gauge-pointer");
      const gaugeBarEl = document.getElementById("gauge-bar");
      const marksEl = document.getElementById("gauge-marks");
      if (!gaugeContainer || !gaugeBarEl || !marksEl || !pointerEl) return;
      // 確保警戒值為有效數值；若缺失則提供備用值
      const val1 = Number.isFinite(a1) ? a1 : null;
      const val2 = Number.isFinite(a2) ? a2 : null;
      const val3 = Number.isFinite(a3) ? a3 : null;
      if (val1 === null && val3 === null) { gaugeContainer.style.display = "none"; return;} // 若主要警戒值不足以繪製區間，直接隱藏容器
      const topAlert = val1 ?? val2 ?? val3;
      const bottomAlert = val3 ?? val2 ?? val1;
      const alertDiff = Math.max(topAlert - bottomAlert, 1); // 避免相減為 0
      // 計算儀表條上下限
      const minVal = Math.max(0, Math.floor(bottomAlert - alertDiff * 3.5 * 2));
      const maxVal = Math.ceil(topAlert + alertDiff * 0.3);
      const totalRange = maxVal - minVal || 1;
      gaugeContainer.style.display = "block";
      // 計算各警戒百分比 (限制在 0 ~ 100)
      const calcPct = (v) => (v !== null ? Math.max(0, Math.min(100, ((v - minVal) / totalRange) * 100)) : null);
      const p2 = calcPct(val2) ?? 0;
      const p3 = calcPct(val3) ?? p2;
      const p1 = calcPct(val1) ?? p2;
      // 設定分段色塊背景
      gaugeBarEl.style.background = ` linear-gradient(to right, #198754 0%, #198754 ${p3}%, 
                                                                #ffc107 ${p3}%, #ffc107 ${p2}%, 
                                                                #fd7e14 ${p2}%, #fd7e14 ${p1}%, 
                                                                #dc3545 ${p1}%, #dc3545 100%) `;
      // 渲染刻度
      let marksHtml = ` <div class="gauge-mark text-muted" style="left: 0%; transform: translateX(0);">${minVal}m</div>
                        <div class="gauge-mark text-muted" style="left: 100%; transform: translateX(-100%);">${maxVal}m</div> `;
      const alertConfigs = [ { level: '三級', val: val3, pct: p3, color: '#d39e00' },
                             { level: '二級', val: val2, pct: p2, color: '#e65100' },
                             { level: '一級', val: val1, pct: p1, color: '#c62828' } ];
      // 過濾掉無效數值後串接 HTML
      marksHtml += alertConfigs
      .filter(item => item.val !== null)
      .map(item => `
        <div class="gauge-mark text-center" style="left: ${item.pct}%;">
          <span class="d-block fw-bold" style="color: ${item.color};">${item.level}</span>
          <span class="d-block text-muted">${item.val}m</span>
        </div>
      `).join('');
      marksEl.innerHTML = marksHtml;
      // 設定指針位置
      if (Number.isFinite(currentLevel)) {
        pointerEl.style.display = "block";
        const pointerPct = Math.max(0, Math.min(100, ((currentLevel - minVal) / totalRange) * 100));
        pointerEl.style.left = `${pointerPct}%`;
      } else { pointerEl.style.display = "none"; }
    }
    // 渲染水位顯示卡片的基本內容
    function renderStationInfoView(stationData) {
      const infoDiv = document.getElementById('station-info');
      if (!infoDiv) return;
      const levelStr = (typeof stationData.level === 'number') ? `${stationData.level.toFixed(2)}` : '--';
      const buttonsHtml = PUSH_PLATFORMS.map(p => `
        <button type="button" id="add-to-${p.id}-push-list" class="btn btn-primary btn-sm">加入到 ${p.name} 推播清單</button>
      `).join('');
      infoDiv.innerHTML = `
        <div class="row align-items-center mb-2">
          <div class="col d-flex align-items-center gap-2 flex-wrap">
            <div>
              <h4 class="h5 fw-bold text-dark mb-0">${stationData.name}</h4>
              <span class="small text-muted">集水區：${stationData.basin || '未知'}</span>
            </div>
            <div class="d-flex gap-2 ms-auto ms-md-2">
              ${buttonsHtml}
            </div>
          </div>
          <div class="col-auto text-end">
            <span class="display-6 fw-bold text-primary">${levelStr}</span>
            <span class="fs-6 text-muted">m</span>
          </div>
        </div>
      `;
    }
    // 抓取與處理 CCTV 攝影機影像
    async function loadCameraData(water_level_sta, camera_sta, camera_id, camera_sourceid) {
      const cameraBtn = document.getElementById('camera-button');
      if (!cameraBtn) return;
      // if (!camera_id || !camera_sourceid) { cameraBtn.classList.add('d-none'); return; } // 無完整攝影機資訊直接隱藏按鈕
      try {
        const url = `https://fhyv.wra.gov.tw/FhyWeb/v1/Api/CCTV/WRA/Cameras/${camera_sourceid}/${camera_id}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const rawText = await response.text();
        let latestImages = [];
        // 使用萬用正規表示式 (Regex) 直接搜尋文字中的圖片 URL，支援 http/https，副檔名為 jpg, jpeg, png, 或動態串流網址
        const matchedUrls = rawText.match(/(https?:\/\/[^\s<>"']+\.(?:jpg|jpeg|png)(?:\?[^\s<>"']*)?)/gi);
        if (matchedUrls) {
          // 依照相機分組，僅保留檔名最大的網址
          const grouped = matchedUrls.reduce((acc, url) => {
            const [, id, file] = url.match(/new\/(\d+)\/([^/?#]+)/i) || [];
            const key = id || url;
            if (!acc[key] || file > acc[key].file) acc[key] = { url, file };
            return acc;
          }, {});
          latestImages = Object.values(grouped).map(item => item.url); // 取出最終篩選後的網址陣列
        } else { cameraBtn.classList.add('d-none'); return; } // 若無法解析直接隱藏
        if (latestImages.length === 0) { cameraBtn.classList.add('d-none'); return; } // 若無有效影像直接隱藏
        cameraBtn.classList.remove('d-none'); // 顯示按鈕
        // 重新綁定點擊事件（Clone 避免重複綁定）
        const newBtn = cameraBtn.cloneNode(true);
        cameraBtn.parentNode.replaceChild(newBtn, cameraBtn);
        newBtn.addEventListener('click', () => {
          showCameraModal(water_level_sta, camera_sta, latestImages);
        });
      } catch (err) { cameraBtn.classList.add('d-none'); }
    }
    // 控制預先寫好的 HTML Modal 顯示與切換邏輯
    function showCameraModal(water_level_sta, camera_sta, imageUrls) {
      const modalEl = document.getElementById('cctv-modal');
      const titleEl = document.getElementById('cctv-modal-title');
      const selectContainer = document.getElementById('cctv-select-container');
      const cameraSelect = document.getElementById('cctv-camera-select');
      const imgDisplay = document.getElementById('cctv-image-display');
      if (!modalEl || !titleEl || !selectContainer || !cameraSelect || !imgDisplay) return;
      // 設定 Modal 標題
      titleEl.textContent = `${water_level_sta}水位站周圍${camera_sta}的現況`;
      imgDisplay.src = imageUrls[0]; // 設定預設顯示第一張影像
      // 多個鏡頭時顯示 Dropdown 切換選單
      if (imageUrls.length > 1) {
        selectContainer.classList.remove('d-none');
        selectContainer.classList.add('d-flex');
        cameraSelect.innerHTML = imageUrls.map((_, index) =>  `<option value="${index}">鏡頭 ${index + 1}</option>`).join('');
        cameraSelect.onchange = (e) => {
          const idx = Number(e.target.value);
          imgDisplay.src = imageUrls[idx] || '';
        };
      } else {
        selectContainer.classList.add('d-none');
        selectContainer.classList.remove('d-flex');
      }
      // 開啟 Modal
      const bsModal = bootstrap.Modal.getOrCreateInstance(modalEl);
      bsModal.show();
    }
    // 通用加入推播清單事件綁定器
    function bindPlatformPushEvents(stationId, stationName) {
      PUSH_PLATFORMS.forEach(platform => {
        const btn = document.getElementById(`add-to-${platform.id}-push-list`);
        if (!btn) return;
        const newBtn = btn.cloneNode(true); // 避免重複綁定事件
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener('click', () => { pushListService.execute(
          () => pushListService.addStation(platform.id, stationId, stationName), platform.refreshFn); });
      });
    }
    // 選取測站獲取站點資料的主函數
    function selectStation(feature) {
      const stationData = WaterDataService.getStationDetails(feature);
      const { id, name, basin, level, alert1, alert2, alert3, camera_sta, camera_id, camera_sourceid } = stationData;
      if (basin && basinSelect.value !== basin) {
        basinSelect.value = basin;
        onBasinChange(basin);
      }
      renderStationInfoView(stationData);
      bindPlatformPushEvents(id, name);
      highlightStation(id);
      loadCameraData(name, camera_sta, camera_id, camera_sourceid);
      if (!Number.isFinite(level) || (!Number.isFinite(alert1) && !Number.isFinite(alert2) && !Number.isFinite(alert3))) {
        clearStationSelection();
        return;
      }
      updateStationStatusUI(level, alert1, alert2, alert3);
      renderGaugeBar(level, stationData.a3, stationData.a2, stationData.a1);
    }
    function zoomToBasin(basinName) {
      if (!geoData.basin || !globalProject) return;
      document.querySelectorAll('.basin-land').forEach(el => {
        if (el.getAttribute('data-basin-name') === basinName) { el.classList.add('highlighted'); }
        else { el.classList.remove('highlighted'); }
      });
      const basinFeatures = geoData.basin.features.filter(f => {
        const name = f.properties.BASIN_NAME || f.properties.BasinName;
        return name === basinName;
      });
      if (basinFeatures.length === 0) return;
      let allX = [], allY = [];
      basinFeatures.forEach(feature => {
        const geom = feature.geometry;
        let polygons = geom.type === "Polygon" ? [geom.coordinates] : (geom.type === "MultiPolygon" ? geom.coordinates : []);
        polygons.forEach(poly => {
          poly[0].forEach(coord => {
            const [x, y] = globalProject(coord[0], coord[1]);
            allX.push(x);
            allY.push(y);
          });
        });
      });
      if (allX.length === 0) return;
      const minX = Math.min(...allX), maxX = Math.max(...allX);
      const minY = Math.min(...allY), maxY = Math.max(...allY);
      const zoomPadding = 20;
      const svgEl = document.getElementById('taiwan-svg');
      svgEl.setAttribute("viewBox", `${minX - zoomPadding} ${minY - zoomPadding} ${maxX - minX + zoomPadding * 2} ${maxY - minY + zoomPadding * 2}`);
    }
    function onBasinChange(selectedBasin) {
      stationSelect.innerHTML = '<option value="" class="text-center">-- 請選擇水位站 --</option>';
      if (!selectedBasin || !geoData.stations) {
        stationSelect.disabled = true;
        resetMapZoom();
        return;
      }
      const filteredStations = geoData.stations.features.filter(f => WaterDataService.getStationBasin(f) === selectedBasin);
      filteredStations.forEach(st => {
        const id = WaterDataService.getStationId(st);
        const name = WaterDataService.getStationName(st);
        stationSelect.innerHTML += `<option value="${id}" class="text-center">${name}</option>`;
      });
      stationSelect.disabled = false;
      zoomToBasin(selectedBasin);
      // 將該流域移至父容器的最後面（最上層）
      const targetPaths = document.querySelectorAll(`path[data-basin-name="${selectedBasin}"]`);
      targetPaths.forEach(path => { path.parentNode.appendChild(path); });
    }
    basinSelect.addEventListener('change', (e) => { onBasinChange(e.target.value); });
    function resetMapZoom() {
      const svgEl = document.getElementById('taiwan-svg');
      if (svgEl && defaultViewBox) { svgEl.setAttribute("viewBox", defaultViewBox); }
      document.querySelectorAll('.basin-land').forEach(el => el.classList.remove('highlighted'));
      document.querySelectorAll('.station-node').forEach(el => el.classList.remove('selected'));
      basinSelect.value = "";
      stationSelect.innerHTML = '<option value="" class="text-center">-- 請選擇水位站 --</option>';
      stationSelect.disabled = true;
      // 重設水位顯示區
      document.getElementById('station-info').innerHTML = `<div class="text-muted small text-center py-4">請於搜尋區選擇或直接點擊地圖上的水位站...</div>`;
      document.getElementById('camera-button')?.classList.add('d-none');
      clearStationSelection()
    }
