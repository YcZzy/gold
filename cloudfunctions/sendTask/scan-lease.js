// A singleton transaction prevents old/duplicate timer triggers from multiplying scans.
async function claim(db, now) {
  const slot = Math.floor(now/60000);
  return db.runTransaction(async tx => {
    const ref = tx.collection('cloudCallBudgets').doc('system:minute-scan');
    let previous;
    try { previous=(await ref.get()).data; }
    catch(e) {
      if (!['DOCUMENT_NOT_FOUND','DATABASE_DOCUMENT_NOT_EXIST',-502001].includes(e.code || e.errCode) &&
          !/document.*(?:not found|not exist|does not exist)/i.test(e.errMsg || e.message || '')) throw e;
    }
    if (previous && previous.slot >= slot) return false;
    await ref.set({data:{slot,updatedAt:now}});
    return true;
  });
}
module.exports={claim};
