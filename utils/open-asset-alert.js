// The sender's follow state never crosses a share link. The caller supplies
// the recipient's own follow state and a function to add the asset.
module.exports = async function openAssetAlert(wx, { assetId, following, follow, active, onError }) {
  if (!following) {
    let confirmed;
    try {
      confirmed = await new Promise((resolve, reject) => wx.showModal({
        title: "先加入自选",
        content: "加入自选后才可设置提醒",
        confirmText: "加入自选",
        cancelText: "暂不加入",
        success: result => resolve(result.confirm),
        fail: reject,
      }));
    } catch (error) {
      if (active()) onError("加入自选后才可设置提醒，请稍后重试");
      return;
    }
    if (!confirmed || !active() || !(await follow())) return;
  }
  if (!active()) return;
  wx.navigateTo({
    url: "/pages/asset-alert/asset-alert?assetId=" + encodeURIComponent(assetId),
    fail: () => { if (active()) onError("暂时无法打开提醒，请重试"); },
  });
};
