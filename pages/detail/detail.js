const cache = require("../../utils/read-cache");
const gold = require("../../utils/gold-api");
const market = require("../../utils/market-client");
const portfolio = require("../../utils/portfolio-client");
const theme = require("../../utils/theme");
const fmt = require("../../utils/asset-format");
const { createKlineChart } = require("../../utils/candle-chart");
const features = require("../../utils/chart-features");
const discovery = require('../../utils/discovery-client');
const display = require("../../utils/display-preferences");
Page({
  data: {
    theme: theme.getTheme(),
    quiet: false,
    chartInteraction: "inspect",
    bollEnabledDraft: false,
    volumeMaEnabledDraft: false,
    granularityOptions: [{value:"day",label:"日K"},{value:"week",label:"周K"},{value:"month",label:"月K"}],
    canOlder: false, canNewer: false, canZoomIn: false, canZoomOut: false,
    partialHint: "",
    reminderIcon: theme.ICON_BELL_GOLD,
    asset: null,
    quote: fmt.quote(),
    following: false,
    followingReady: false,
    rules: [],
    annotation: { note: "", tags: [] },
    noteEditing: false,
    noteDraft: "",
    noteCount: 0,
    tagsDraft: "",
    noteError: "",
    noteConflict: false,
    noteStatus: "",
    priceTargets: [],
    indicatorSettings: features.DEFAULT_SETTINGS,
    indicatorEditing: false,
    maDraft: "5,10",
    maEnabledDraft: true,
    subIndicatorDraft: "volume",
    maLegend: "MA5 / MA10",
    indicatorError: "",
    indicatorNotice: "",
    macdSummary: "",
    indicatorHint: "",
    period: "intraday",
    chartPeriod: "intraday",
    periods: [
      { value: "intraday", label: "当日" },
      { value: "1mo", label: "1月" },
      { value: "3mo", label: "3月" },
      { value: "1y", label: "1年" },
      { value: "5y", label: "5年" },
    ],
    errorText: "",
    chartError: "",
    chartLoading: false,
    refreshing: false,
    chartSource: "",
    hasChart: false,
    chartHint: "",
    selectedInfo: "",
    intl: null,
    intlError: "",
    busy: false,
    extraMode: '',
    extraBusy: false,
    extraError: '',
    extraSource: '',
    extraTime: '',
    extraCached: false,
    bookRows: [],
    flowRows: [],
  },
  onLoad(options) {
    this.setData({ theme: theme.getTheme(), quiet: display.get().quiet });
    theme.applyChrome(this.data.theme);
    this.assetId = options.assetId;
    this._alive = true;
    this.bars = [];
    this.restoreIndicators();
    const saved = cache.forPlatform(wx);
    const asset = saved.read("asset:" + this.assetId);
    const quote = saved.read("quote:" + this.assetId);
    if (asset) this.setData({ asset });
    if (quote) this.setData({ quote: fmt.quote(quote.quote, asset || {}) });
    this.restorePortfolio();
  },
  async onShow() {
    this._visible = true;
    this.restoreIndicators();
    this.setData({ theme: theme.getTheme(), quiet: display.get().quiet });
    theme.applyChrome(this.data.theme);
    if (this.chart) this.chart.setColors(display.colors(theme.chartColors(this.data.theme)));
    this.stopPolling();
    this.restorePortfolio();
    await this.reload();
    if (this._visible) this.timer = setInterval(() => this.refreshMarket(), 60000);
  },
  onReady() {
    this.queueChartRender();
  },
  onHide() {
    this._extraRequest = (this._extraRequest || 0) + 1;
    this._visible = false;
    this._canvasEpoch = (this._canvasEpoch || 0) + 1;
    this._portfolioRequest = (this._portfolioRequest || 0) + 1;
    this._portfolioPending = null;
    this._refreshRequest = (this._refreshRequest || 0) + 1;
    this._intlRequest = (this._intlRequest || 0) + 1;
    this.setData({ refreshing: false, chartLoading: false, extraBusy:false });
    this.stopPolling();
    this._quoteRequest = (this._quoteRequest || 0) + 1;
    this._chartRequest = (this._chartRequest || 0) + 1;
  },
  onUnload() {
    this._alive = false;
    this.onHide();
  },
  stopPolling() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  },
  async reload() {
    await Promise.all([this.loadPortfolio(), this.loadAsset()]);
  },
  async loadAsset() {
    try {
      const result = await market.resolve(this.assetId);
      if (!this._alive || !this._visible) return;
      const rawAsset = result.asset || result;
      const asset = { ...rawAsset, ...fmt.identity(rawAsset) };
      this.setData({ asset, errorText: "" });
      this.refreshTargets();
      await this.refreshMarket();
    } catch (e) {
      // Keep the previous successful data.
    }
  },
  async refreshMarket() {
    if (this.data.refreshing || !this._visible) return;
    const request = (this._refreshRequest = (this._refreshRequest || 0) + 1);
    this.setData({ refreshing: true });
    try {
      await Promise.all([this.loadQuote(), this.loadChart(), this.loadIntl(), this.loadExtra()]);
    } finally {
      if (this._alive && request === this._refreshRequest) this.setData({ refreshing: false });
    }
  },
  async loadIntl() {
    if (this.assetId !== "gold-au9999") return;
    const request = (this._intlRequest = (this._intlRequest || 0) + 1);
    try {
      const ref = await cache.forPlatform(wx).fetch("intl:gold-au9999", () => gold.getIntlRef(), r => !!(r && r.price != null && r.cnyPerGram != null));
      if (!this._alive || !this._visible || request !== this._intlRequest)
        return;
      this.setData({
        intl: {
          usdText: fmt.number(ref.price),
          cnyText: fmt.number(ref.cnyPerGram),
          rateText: fmt.number(ref.usdCny, 4),
          source: fmt.sourceName(ref.source),
        },
        intlError: "",
      });
    } catch (e) {
      // Preserve the last international reference, including its exchange rate.
    }
  },
  async chooseExtra(e) {
    const mode=e.currentTarget.dataset.mode;
    if(!['orderbook','flow'].includes(mode)||!this._visible)return;
    const asset=this.data.asset;
    if(!asset || asset.kind!=='stock' || !['SH','SZ'].includes(asset.market))return;
    if(mode===this.data.extraMode){this._extraRequest=(this._extraRequest||0)+1;this.setData({extraMode:'',extraBusy:false,extraError:''});return;}
    this.setData({extraMode:mode,extraError:'',extraSource:'',extraTime:'',extraCached:false,
      ...(mode==='orderbook'?{bookRows:[]}:{flowRows:[]})});
    await this.loadExtra();
  },
  async loadExtra() {
    const mode=this.data.extraMode;
    if(!mode || !this._visible || !this.data.asset)return;
    const request=this._extraRequest=(this._extraRequest||0)+1;
    this.setData({extraBusy:true,extraError:''});
    try{
      const result=await discovery[mode](this.assetId);
      if(!this._alive || !this._visible || request!==this._extraRequest || mode!==this.data.extraMode)return;
      const precision=this.data.asset.precision ?? 2;
      const patch={extraSource:fmt.sourceName(result.source),extraTime:fmt.time(result.sourceTime),extraCached:!!(result.cached||result.stale)};
      if(mode==='orderbook')patch.bookRows=Array.from({length:5},(_,i)=>({depth:i+1,
        bidPrice:fmt.number(result.bids?.[i]?.price,precision),bidVolume:fmt.number(result.bids?.[i]?.volume,0),
        askPrice:fmt.number(result.asks?.[i]?.price,precision),askVolume:fmt.number(result.asks?.[i]?.volume,0)}));
      else patch.flowRows=[['main','主力净额'],['superLarge','超大单'],['large','大单'],['medium','中单'],['small','小单']].map(([key,label])=>{
        const value=result.flow?.[key];let amount='--';
        if(typeof value==='number'&&Number.isFinite(value))amount=Math.abs(value)>=1e8?fmt.number(value/1e8)+' 亿元':Math.abs(value)>=1e4?fmt.number(value/1e4)+' 万元':fmt.number(value)+' 元';
        const pct=result.flow?.[key+'Pct'];
        return{key,label,amount,pctText:typeof pct==='number'&&Number.isFinite(pct)?fmt.signed(pct)+'%':'--'};
      });
      this.setData(patch);
    }catch(error){if(this._alive&&this._visible&&request===this._extraRequest)this.setData({extraError:error.message||'数据暂不可用，请稍后重试',extraCached:true});}
    finally{if(this._alive&&this._visible&&request===this._extraRequest)this.setData({extraBusy:false});}
  },
  restorePortfolio() {
    const saved = portfolio.getCached && portfolio.getCached();
    if (saved && !this.data.busy) this.applyPortfolio(saved);
  },
  applyPortfolio(s) {
    this._portfolioRevision = s.revision;
    this.setData({
      following: s.items.some((a) => a.id === this.assetId),
      followingReady: true,
      annotation: (s.annotations && s.annotations[this.assetId]) || { note: "", tags: [] },
      rules: (s.rules || [])
        .filter((r) => r.assetId === this.assetId)
        .map((r) => ({ ...r, summary: fmt.summary(r, this.data.asset) })),
    });
    if (!this.data.following) this.setData({ noteEditing: false, noteError: "" });
    this.redrawChart();
  },
  startNoteEdit() {
    if (!this.data.following || this.data.busy) return;
    this._annotationRevision = this._portfolioRevision;
    this.setData({ noteEditing: true, noteDraft: this.data.annotation.note || "", noteCount: Array.from(this.data.annotation.note || "").length,
      tagsDraft: (this.data.annotation.tags || []).join(","), noteError: "", noteConflict: false, noteStatus: "" });
  },
  onNoteInput(e) { this.setData({ noteDraft: e.detail.value, noteCount: Array.from(e.detail.value).length, noteError: "" }); },
  onTagsInput(e) { this.setData({ tagsDraft: e.detail.value, noteError: "" }); },
  cancelNoteEdit() {
    if (!this.data.busy) this.setData({ noteEditing: false, noteError: "", noteConflict: false });
  },
  async reloadAnnotation() {
    if (this.data.busy) return;
    this.setData({ busy: true, noteError: "" });
    this._portfolioRequest = (this._portfolioRequest || 0) + 1;
    try {
      const s = await portfolio.list();
      if (s.offline) throw Error('当前离线，原草稿已保留，请联网后重试');
      if (!this._alive || !this._visible) return;
      this.applyPortfolio(s);
      this.setData({ busy: false });
      this.startNoteEdit();
    } catch (error) {
      if (this._alive) this.setData({ noteError: '无法载入最新备注，原草稿已保留，请联网后重试' });
    } finally {
      if (this._alive) this.setData({ busy: false });
    }
  },
  async saveNote() {
    if (this.data.busy || !this.data.noteEditing) return;
    const note = this.data.noteDraft.trim();
    const tags = [...new Set(this.data.tagsDraft.split(/[,，\n]/).map(t => t.trim()).filter(Boolean))];
    if (Array.from(note).length > 120) return this.setData({ noteError: "备注最多 120 字" });
    if (tags.length > 3 || tags.some(t => Array.from(t).length > 8))
      return this.setData({ noteError: "最多 3 个标签，每个最多 8 字" });
    this.setData({ busy: true, noteError: "", noteStatus: "" });
    this._portfolioRequest = (this._portfolioRequest || 0) + 1;
    try {
      const s = await portfolio.saveAnnotation(this.assetId, note, tags, this._annotationRevision);
      if (!this._alive) return;
      this.setData({ noteEditing: false, noteConflict: false, noteStatus: "备注已保存" });
      this.applyPortfolio(s);
    } catch (error) {
      if (this._alive) this.setData({ noteError: error.message || "保存失败，请稍后重试", noteConflict: error.code === 'revision-conflict' });
    } finally {
      if (this._alive) this.setData({ busy: false });
    }
  },
  restoreIndicators() {
    let settings = features.parseSettings(features.DEFAULT_SETTINGS);
    try {
      const saved = wx.getStorageSync(features.STORAGE_KEY);
      if (saved) settings = features.parseSettings(saved);
    } catch (ignore) {}
    this.applyIndicators(settings);
  },
  applyIndicators(settings) {
    this.setData({ indicatorSettings: settings,
      maLegend: settings.maEnabled ? settings.maPeriods.map(n => 'MA' + n).join(' / ') : '均线已关闭' });
  },
  toggleIndicatorEditor() {
    const settings = this.data.indicatorSettings;
    this.setData({ indicatorEditing: !this.data.indicatorEditing, maDraft: settings.maPeriods.join(','),
      bollEnabledDraft: settings.bollEnabled, volumeMaEnabledDraft: settings.volumeMaEnabled,
      maEnabledDraft: settings.maEnabled, subIndicatorDraft: settings.subIndicator, indicatorError: "" });
  },
  onMaInput(e) { this.setData({ maDraft: e.detail.value, indicatorError: "" }); },
  onBollToggle(e) { this.setData({ bollEnabledDraft: e.detail.value }); },
  onVolumeMaToggle(e) { this.setData({ volumeMaEnabledDraft: e.detail.value }); },
  onMaToggle(e) { this.setData({ maEnabledDraft: e.detail.value }); },
  selectSubIndicator(e) { this.setData({ subIndicatorDraft: e.currentTarget.dataset.value }); },
  saveIndicators() {
    try {
      const settings = features.parseSettings({ maText: this.data.maDraft,
        granularity: this.data.indicatorSettings.granularity, bollEnabled: this.data.bollEnabledDraft, volumeMaEnabled: this.data.volumeMaEnabledDraft,
        maEnabled: this.data.maEnabledDraft, subIndicator: this.data.subIndicatorDraft });
      let notice = "设置已保存到本设备";
      try { wx.setStorageSync(features.STORAGE_KEY, settings); }
      catch (ignore) { notice = "本次设置已生效，设备保存失败，重新进入后可能恢复原设置"; }
      this.applyIndicators(settings);
      this.setData({ indicatorEditing: false, indicatorError: "", indicatorNotice: notice });
      this.redrawChart();
    } catch (error) { this.setData({ indicatorError: error.message }); }
  },
  refreshTargets() {
    const period = this._displayPeriod || this.data.period;
    const range = features.chartRange(this.visibleBars || this.bars || [], period === 'intraday' ? 'intraday' : 'candle', this.intradayPrevClose);
    const priceTargets = features.targets(this.data.rules, { ...this.data.asset, id: this.assetId }, this.data.quote.price, range);
    this.setData({ priceTargets });
    if (this.chart && this.chart.setTargets) this.chart.setTargets(priceTargets);
  },
  loadPortfolio() {
    if (this._portfolioPending) return this._portfolioPending;
    const request = (this._portfolioRequest = (this._portfolioRequest || 0) + 1);
    const pending = (async () => {
      try {
        const s = await portfolio.list();
        if (!this._alive || !this._visible || request !== this._portfolioRequest || this.data.busy) return;
        // Offline defaults are not evidence of the user's actual watchlist.
        if (s.offline && !(portfolio.getCached && portfolio.getCached())) return;
        this.applyPortfolio(s);
      } catch (e) {
        // Keep the previous successful data.
      }
    })().finally(() => {
      if (this._portfolioPending === pending) this._portfolioPending = null;
    });
    this._portfolioPending = pending;
    return pending;
  },
  async ensureFollowing() {
    if (!this.data.followingReady) await this.loadPortfolio();
    if (!this._alive || !this._visible) return false;
    if (!this.data.followingReady) {
      this.setData({ errorText: "自选状态暂时无法确认，请稍后重试" });
      return false;
    }
    return true;
  },
  async loadQuote() {
    const n = (this._quoteRequest = (this._quoteRequest || 0) + 1);
    try {
      const result = await market.quote(this.assetId);
      if (!this._alive || n !== this._quoteRequest) return;
      const q = result.quote || result;
      if (q.price == null || !Number.isFinite(Number(q.price)) || Number(q.price) <= 0 || q.status === "unavailable")
        throw Error("行情暂不可用");
      this.setData({
        quote: fmt.quote(q, this.data.asset || {}),
        errorText: "",
      });
      this.refreshTargets();
    } catch (e) {
      if (!this._alive || n !== this._quoteRequest) return;
      this.setData({
        quote: fmt.quote({ ...this.data.quote, stale: true, cached: true }, this.data.asset || {}),
        errorText: this.data.quote.price == null ? "行情暂不可用，请稍后刷新" : "",
      });
      this.refreshTargets();
    }
  },
  async loadChart() {
    const n = (this._chartRequest = (this._chartRequest || 0) + 1);
    const period = this.data.period;
    this.setData({ chartError: "", chartLoading: true });
    try {
      const result = await market.chart(this.assetId, period);
      if (
        !this._alive ||
        n !== this._chartRequest ||
        period !== this.data.period
      )
        return;
      const c = result.chart || result;
      const cached = c.cached || c.stale;
      const bars = c.mode === "intraday" || period === "intraday" ? c.points : c.candles;
      if (!Array.isArray(bars) || !bars.length) {
        throw Error("图表数据为空");
      }
      // Provider cumulative volumes and unknown units cannot be plotted as per-bar volume.
      this.bars = c.volumeUnit == null ? bars.map(bar => ({ ...bar, v: null })) : bars;
      if (this._displayPeriod !== period) this.viewport = {};
      this._displayPeriod = period;
      this.chartTimezone = c.timezone;
      this.intradayPrevClose = c.prevClose;
      this.setData({
        hasChart: true,
        selectedInfo: "",
        chartSource: fmt.sourceName(c.source),
        chartRangeText: bars[0].time + ' 至 ' + bars[bars.length - 1].time,
        chartError: cached ? "图表刷新失败，保留上次图表；可重试或切换周期" : "",
        chartHint: (cached ? "缓存图表 · " : "") +
          (c.coverage && c.coverage.status === 'unverified' ? '历史数据可能不完整 · ' : '') + fmt.time(c.sourceTime),
      });
      this.queueChartRender(n);
    } catch (e) {
      if (!this._alive || n !== this._chartRequest) return;
      this.setData({
        ...(this._displayPeriod ? { period: this._displayPeriod } : {}),
        chartError: this._displayPeriod
          ? "图表刷新失败，保留上次图表；可重试或切换周期"
          : "图表暂不可用，请重试或切换周期",
      });
    } finally {
      if (this._alive && n === this._chartRequest) this.setData({ chartLoading: false });
    }
  },
  queueChartRender(request = this._chartRequest) {
    const epoch = this._canvasEpoch || 0;
    const active = () => this._alive && this._visible && epoch === (this._canvasEpoch || 0) && request === this._chartRequest;
    const render = () => {
      if (!active()) return;
      if (this.chart) this.redrawChart();
      else this.initCanvas(request, epoch).then(() => { if (active()) this.redrawChart(); });
    };
    if (!this.chart && wx.nextTick) wx.nextTick(render);
    else render();
  },
  initCanvas(request = this._chartRequest, epoch = this._canvasEpoch || 0) {
    if (!this._alive || !this._visible) return Promise.resolve();
    return new Promise((resolve) => {
      const q = wx.createSelectorQuery().in(this);
      q.select("#kline")
        .fields({ node: true, size: true, rect: true })
        .exec((res) => {
          const i = res && res[0];
          if (i && i.node && this._alive && this._visible && request === this._chartRequest && epoch === (this._canvasEpoch || 0)) {
            const canvas = i.node;
            const ctx = canvas.getContext("2d");
            const dpr =
              (wx.getWindowInfo && wx.getWindowInfo().windowPixelRatio) || 2;
            canvas.width = i.width * dpr;
            canvas.height = i.height * dpr;
            ctx.scale(dpr, dpr);
            this.canvasRect = { left: i.left || 0 };
            this.chart = createKlineChart({
              canvas,
              ctx,
              width: i.width,
              height: i.height,
              colors: display.colors(theme.chartColors(this.data.theme)),
            });
          }
          resolve();
        });
    });
  },
  redrawChart() {
    if (!this._alive || !this._visible) return;
    const period = this._displayPeriod || this.data.period;
    const settings = this.data.indicatorSettings;
    let history = this.bars || [];
    if (period !== 'intraday') {
      const today = this.exchangeToday();
      history = features.aggregateCandles(history, settings.granularity, today);
      this.chartViewport = features.chartView(history, settings, this.viewport);
      this.viewport = { count: this.chartViewport.count, offset: this.chartViewport.offset };
      this.visibleBars = this.chartViewport.bars;
      this.macdRows = this.chartViewport.indicators.macd;
    } else { this.visibleBars = history; this.macdRows = []; }
    const visible = this.visibleBars;
    const partial = visible.filter(b => b.partial);
    this.setData({
      canOlder: !!this.chartViewport && period !== 'intraday' && this.chartViewport.start > 0,
      canNewer: !!this.chartViewport && period !== 'intraday' && this.chartViewport.offset > 0,
      canZoomIn: visible.length > 10,
      canZoomOut: visible.length < history.length,
      chartRangeText: visible.length ? (visible[0].startTime || visible[0].time) + ' 至 ' + (visible[visible.length - 1].endTime || visible[visible.length - 1].time) : '',
      partialHint: [visible.some(b=>b.startIncomplete) ? '首根周/月 K 的区间起点可能被截断，仅汇总实际取得日期；其完整性未知，指标亦受此影响。' : '',
        visible.some(b=>b.endIncomplete) ? '当前周/月尚未结束；末根 K 线仅汇总已取得的交易日。' : ''].filter(Boolean).join(' '),
    });
    this.refreshTargets();
    const last = this.macdRows[this.macdRows.length - 1];
    this.setData({
      chartPeriod: period,
      macdSummary: last ? this.formatMacd(last) : "",
      indicatorHint: period !== 'intraday' && settings.subIndicator === 'macd' && history.length < 26
        ? "当前不足 26 根 K 线，MACD 基于已加载数据计算，建议切换更长区间。" : "",
    });
    if (!this.chart) return;
    if (this.chart.setIndicators) this.chart.setIndicators(settings);
    if (this.chart.setPrecision) this.chart.setPrecision(this.data.asset && this.data.asset.precision);
    if (period === "intraday")
      this.chart.renderIntraday(this.bars || [], this.intradayPrevClose);
    else this.chart.render(this.visibleBars || [], undefined, this.chartViewport.indicators);
  },
  exchangeToday() {
    // Endpoint candles already carry exchange-local YYYY-MM-DD dates. Only "today" needs zone conversion.
    try {
      const zone = this.chartTimezone || (this.data.asset && this.data.asset.market === 'US' ? 'America/New_York' : 'Asia/Shanghai');
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
      const value = key => parts.find(p => p.type === key).value;
      return value('year') + '-' + value('month') + '-' + value('day');
    } catch (ignore) { return new Date().toISOString().slice(0, 10); }
  },
  switchGranularity(e) {
    const granularity = e.currentTarget.dataset.value;
    try {
      const settings = features.parseSettings({ ...this.data.indicatorSettings, granularity });
      this.applyIndicators(settings); this.viewport = {};
      try { wx.setStorageSync(features.STORAGE_KEY, settings); }
      catch (ignore) { this.setData({ indicatorNotice: '粒度本次已生效，设备保存失败' }); }
      this.redrawChart();
    } catch (error) { this.setData({ indicatorError: error.message }); }
  },
  zoomChart(e) {
    if (!this.chartViewport || (this._displayPeriod || this.data.period) === 'intraday') return;
    const factor = e.currentTarget.dataset.direction === 'in' ? 0.65 : 1.6;
    this.viewport = { count: Math.max(10, Math.round(this.chartViewport.count * factor)), offset: this.chartViewport.offset };
    this.setData({ selectedInfo: '' }); this.redrawChart();
  },
  panChart(e) {
    if (!this.chartViewport || (this._displayPeriod || this.data.period) === 'intraday') return;
    const delta = Math.max(1, Math.round(this.chartViewport.count / 2));
    this.viewport = { count: this.chartViewport.count, offset: this.chartViewport.offset + (e.currentTarget.dataset.direction === 'older' ? delta : -delta) };
    this.setData({ selectedInfo: '' }); this.redrawChart();
  },
  latestChart() {
    this.viewport = { ...(this.viewport || {}), offset: 0 };
    this.setData({ selectedInfo: '' }); this.redrawChart();
  },
  selectChartInteraction(e) {
    const value = e.currentTarget.dataset.value;
    if (!['inspect', 'pan'].includes(value)) return;
    this.setData({ chartInteraction: value });
  },
  onChartTouchStart(e) {
    const t = (e.touches || [])[0];
    this._touchStartX = t && (t.x == null ? t.clientX : t.x);
    // Freeze the mode until this finger lifts; switching controls cannot steal an active gesture.
    this._gestureMode = (this._displayPeriod || this.data.period) === 'intraday' ? 'inspect' : this.data.chartInteraction;
    if (this._gestureMode === 'inspect') this.onTouch(e);
  },
  onChartTouchMove(e) {
    if (this._gestureMode === 'inspect') { this.onTouch(e); return; }
    if (this._gestureMode !== 'pan') return;
    const t = (e.touches || [])[0];
    const x = t && (t.x == null ? t.clientX : t.x);
    if (Number.isFinite(x) && Number.isFinite(this._touchStartX) && Math.abs(x - this._touchStartX) > 45) {
      this.panChart({ currentTarget: { dataset: { direction: x > this._touchStartX ? 'older' : 'newer' } } });
      this._touchStartX = x;
    }
  },
  onChartTouchEnd() { this._touchStartX = null; this._gestureMode = null; },
  formatMacd(row) {
    return `DIF ${fmt.number(row.dif, 3)} · DEA ${fmt.number(row.dea, 3)} · MACD ${fmt.number(row.histogram, 3)}`;
  },
  switchPeriod(e) {
    const period = e.currentTarget.dataset.period;
    if (period === this.data.period && !this.data.chartError) return;
    this.setData({ period });
    return this.loadChart();
  },
  onTouch(e) {
    if (!this.chart || !this.bars.length) return;
    const t = (e.touches || [])[0] || (e.changedTouches || [])[0];
    if (!t) return;
    const hit = this.chart.touchAt(
      t.x == null ? t.clientX - (this.canvasRect || {}).left : t.x,
    );
    if (!hit) return;
    const precision = this.data.asset && this.data.asset.precision != null ? this.data.asset.precision : 2;
    const period = this._displayPeriod || this.data.period;
    this.setData({
      ...(period !== 'intraday' && this.macdRows && this.macdRows[(this.visibleBars || this.bars).indexOf(hit)]
        ? { macdSummary: this.formatMacd(this.macdRows[(this.visibleBars || this.bars).indexOf(hit)]) } : {}),
      selectedInfo:
        period === "intraday"
          ? `${hit.time} · 价 ${fmt.number(hit.price, precision)} · 均 ${fmt.number(hit.avg, precision)}`
          : `${hit.startTime || hit.time}${hit.endTime ? ' 至 ' + hit.endTime : ''}${hit.partial ? '（部分周期）' : ''} · 开 ${fmt.number(hit.o, precision)} 高 ${fmt.number(hit.h, precision)} 低 ${fmt.number(hit.l, precision)} 收 ${fmt.number(hit.c, precision)}`,
    });
  },
  async follow() {
    if (this.data.busy) return false;
    this.setData({ busy: true, errorText: "" });
    this._portfolioRequest = (this._portfolioRequest || 0) + 1;
    try {
      const s = await portfolio.add(this.assetId);
      if (this._alive) this.applyPortfolio(s);
      return true;
    } catch (e) {
      if (this._alive) this.setData({ errorText: e.message });
      return false;
    } finally {
      if (this._alive) this.setData({ busy: false });
    }
  },
  async toggleFollow() {
    if (this.data.busy) return;
    if (!this.data.followingReady && !(await this.ensureFollowing())) return;
    if (this.data.busy) return;
    if (!this.data.following) return this.follow();
    wx.showModal({
      title: "删除自选",
      content: "删除后，该标的的全部通知提醒也将一并删除，重新添加不会恢复。确定删除？",
      success: async (r) => {
        if (!r.confirm || this.data.busy) return;
        this.setData({ busy: true });
        this._portfolioRequest = (this._portfolioRequest || 0) + 1;
        try {
          const s = await portfolio.remove(this.assetId);
          if (this._alive) this.applyPortfolio(s);
        } catch (e) {
          if (this._alive) this.setData({ errorText: e.message });
        } finally {
          if (this._alive) this.setData({ busy: false });
        }
      },
    });
  },
  async openAlert() {
    if (this.data.busy || this._openingAlert) return;
    if (!this.data.followingReady) {
      this._openingAlert = true;
      const ready = await this.ensureFollowing();
      this._openingAlert = false;
      if (!ready || this.data.busy) return;
    }
    const go = () =>
      wx.navigateTo({
        url:
          "/pages/asset-alert/asset-alert?assetId=" +
          encodeURIComponent(this.assetId),
      });
    if (this.data.following) return go();
    wx.showModal({
      title: "先加入自选",
      content: "加入自选后才可设置提醒",
      confirmText: "加入自选",
      cancelText: "暂不加入",
      success: async (r) => {
        if (r.confirm && (await this.follow())) go();
      },
      fail: () => {
        if (this._alive) this.setData({
          errorText: "加入自选后才可设置提醒，请先点击右上角「自选」",
        });
      },
    });
  },
  onPullDownRefresh() {
    return this.reload().finally(() => wx.stopPullDownRefresh());
  },
});
