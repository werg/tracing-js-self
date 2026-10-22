async function run() {
  const a = host.readAsync("A");
  const b = host.readAsync("B");
  const bias = await Promise.resolve(5);
  const x = await a;
  const y = await b;
  host.store("sum", x + y + bias);
}
run();
