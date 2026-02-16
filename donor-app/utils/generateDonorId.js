function generateDonorId() {
  return "DN" + Date.now();
}

module.exports = generateDonorId;
