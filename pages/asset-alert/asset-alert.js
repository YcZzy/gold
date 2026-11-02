const createSettings = require("../../utils/reminder-settings");
Page(createSettings({
  market: require("../../utils/market-client"),
  portfolio: require("../../utils/portfolio-client"),
  theme: require("../../utils/theme"),
  fmt: require("../../utils/asset-format"),
  statusClient: require("../../utils/status-client"),
  templates: require("../../utils/app-config").templates,
  wx,
}));
