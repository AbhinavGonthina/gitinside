// A JS script that sets env vars before importing the app: TypeScript binds these
// assignments as declarations of `process`, which must not hide the global elsewhere.
process.env.NODE_ENV = "test";
process.exitCode = 0;
