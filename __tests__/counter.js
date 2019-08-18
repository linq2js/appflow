import flow from "appflow";
import fetch from "node-fetch";

test("CounterFlow should work properly", async () => {
  const increaseReducer = ({ mutate }) => mutate.add(1);
  const decreaseReducer = ({ mutate }) => mutate.add(-1);
  const loadReducer = ({ mutate }) =>
    fetch("http://www.mocky.io/v2/5d57e42c2f0000ae465454c0")
      .then(res => res.json())
      .then(value => mutate.set(value));
  const evenOddResolver = state => (state % 2 === 0 ? "#even" : "#odd");

  const actions = {
    increase: flow("#increase"),
    decrease: flow("#decrease"),
    load: flow("#load")
  };

  const counterFlow = flow.state(0).on({
    increase: flow
      .id("increase")
      .state(increaseReducer)
      .next(evenOddResolver),
    load: flow
      .id("load")
      .state(loadReducer)
      .next(evenOddResolver),
    decrease: flow
      .id("decrease")
      .state(decreaseReducer)
      .next(evenOddResolver),
    even: flow
      .id("even")
      .internal()
      .on({
        ...actions,
        isEven: flow.back()
      }),
    odd: flow
      .id("odd")
      .internal()
      .on({
        ...actions,
        isOdd: flow.back()
      })
  });

  counterFlow.dispatch("even");

  expect(counterFlow.can("even")).toBe(true);

  counterFlow.dispatch("odd");

  expect(counterFlow.can("even")).toBe(true);

  counterFlow.dispatch("increase");

  expect(counterFlow.getState()).toBe(1);

  expect(counterFlow.can("isOdd")).toBe(true);

  expect(counterFlow.can("isEven")).toBe(false);

  expect(counterFlow.can("load")).toBe(true);

  await counterFlow.dispatch("load");

  expect(counterFlow.getState()).toBe(999);
});

test("debounce", done => {
  const Counter = flow
    .state(0)
    .on({ increase: flow.state(({ state }) => state + 1).debounce(100) });

  Counter.dispatch("increase");
  Counter.dispatch("increase");
  Counter.dispatch("increase");
  Counter.dispatch("increase");

  expect(Counter.value).toBe(0);

  setTimeout(() => {
    expect(Counter.value).toBe(1);
    done();
  }, 150);
});
