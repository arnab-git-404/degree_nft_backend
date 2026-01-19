exports.batchUpload = async (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({ message: "No file uploaded." });
  }

  res
    .status(200)
    .json({ message: "This Function is in the early Stage of Development..." });
};

exports.getAllReports = async (req, res, next) => {
  res
    .status(200)
    .json({ message: "This Function is in the early Stage of Development.." });
};

exports.getAllUploadedData = async (req, res, next) => {
  res
    .status(200)
    .json({ message: "This Function is in the early Stage of Development.." });
};

exports.updateNftAllocations = async (req, res, next) => {
  res
    .status(200)
    .json({ message: "This Function is in the early Stage of Development..." });
};
