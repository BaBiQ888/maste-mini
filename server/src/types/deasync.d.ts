declare module "deasync" {
  function loopWhile(pred: () => boolean): void;
  export default { loopWhile };
}
