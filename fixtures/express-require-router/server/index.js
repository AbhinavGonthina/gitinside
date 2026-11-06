const express = require("express");

const app = express();
app.use(express.json());
app.use("/api/trips", require("./routes/trips"));

app.listen(4000);
