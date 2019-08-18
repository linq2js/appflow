import $ from "appflow";
import fetch from "node-fetch";

test("state of flow should be clean after reset call", () => {
  const f = $.state(0).on({
    click: $.state(({ state }) => state + 1)
  });

  f.dispatch("click");

  expect(f.getState()).toBe(1);

  f.reset();

  expect(f.getState()).toBe(0);
});

test("Finding flow by id", () => {
  const f = $.on({
    click: $.id("level1")
  });

  f.on("#level1", {
    click: $.id("level2")
  });

  expect(f.__findById("level1")).toBeDefined();
  expect(f.__findById("level2")).toBeDefined();
});

test("TrafficLightFlow should work properly", () => {
  const ActionTypes = {
    Timer: 1,
    Timer2: 2
  };

  const TrafficLightFlow = $.id("root").on({
    [ActionTypes.Timer]: $.state("green").on({
      [ActionTypes.Timer]: $.state("yellow").on({
        [ActionTypes.Timer]: $.state("red").restart()
      })
    })
  });

  TrafficLightFlow.dispatch(ActionTypes.Timer);

  expect(TrafficLightFlow.can(ActionTypes.Timer)).toBe(true);

  expect(TrafficLightFlow.can(ActionTypes.Timer2)).toBe(false);

  expect(TrafficLightFlow.getState()).toBe("green");

  TrafficLightFlow.dispatch(ActionTypes.Timer);

  expect(TrafficLightFlow.getState()).toBe("yellow");

  TrafficLightFlow.dispatch(ActionTypes.Timer);

  expect(TrafficLightFlow.getState()).toBe("red");

  TrafficLightFlow.dispatch(ActionTypes.Timer);

  expect(TrafficLightFlow.getState()).toBe("green");
});

test("CounterFlow should work properly", () => {
  const ActionTypes = {
    Increase: 1,
    Decrease: 2
  };

  const CounterFlow = $.state(0).on({
    [ActionTypes.Increase]: $.state(({ state }) => state + 1).restart(),
    [ActionTypes.Decrease]: $.state(({ state }) => state - 1).restart()
  });

  expect(CounterFlow.getState()).toBe(0);

  CounterFlow.dispatch(ActionTypes.Increase);
  CounterFlow.dispatch(ActionTypes.Increase);

  expect(CounterFlow.getState()).toBe(2);

  CounterFlow.dispatch(ActionTypes.Decrease);

  expect(CounterFlow.getState()).toBe(1);
});

test("AsyncFlow should work properly", async () => {
  const ActionTypes = {
    Load: 1
  };

  const LoadReducer = () =>
    fetch("http://www.mocky.io/v2/5185415ba171ea3a00704eed", {
      method: "PUT"
    }).then(res => res.json());

  const AsyncFlow = $.state(false).on({
    [ActionTypes.Load]: $.state(LoadReducer)
  });

  expect(AsyncFlow.getState()).toBe(false);

  await AsyncFlow.dispatch(ActionTypes.Load);

  expect(AsyncFlow.getState()).toEqual({
    hello: "world"
  });
});

test("TodoFlow should work properly", () => {
  const ActionTypes = {
    Add: 1,
    Remove: 2,
    Toggle: 3,
    Edit: 4,
    Save: 5,
    Cancel: 6,
    Update: 7
  };

  let uniqueId = 1;

  function addReducer({ state: { ids, data } }, text) {
    const id = uniqueId++;
    return {
      ids: ids.concat(id),
      data: {
        ...data,
        [id]: {
          id,
          text
        }
      }
    };
  }

  function editReducer({ getState }, id) {
    return {
      ...getState().data[id]
    };
  }

  function updateReducer({ state }, text) {
    return {
      ...state,
      text
    };
  }

  const saveReducer = ({ state: { editing }, mutate }) =>
    mutate.unset("editing").prop`data`.set(editing.id, editing);

  function cancelReducer({ state: { editing, ...state } }) {
    return state;
  }

  const TodoFlow = $.state({
    ids: [],
    data: {}
  }).on({
    [ActionTypes.Add]: $.state(["ids", "data"], addReducer).restart(),
    [ActionTypes.Edit]: $.state("editing", editReducer)
      .id("editing")
      .on({
        [ActionTypes.Update]: $.state("editing", updateReducer).back(),
        [ActionTypes.Save]: $.state(saveReducer).restart(),
        [ActionTypes.Cancel]: $.state(cancelReducer).restart()
      })
  });

  TodoFlow.dispatch(ActionTypes.Add, "item 1");
  TodoFlow.dispatch(ActionTypes.Add, "item 2");

  expect(TodoFlow.getState()).toEqual({
    ids: [1, 2],
    data: {
      1: {
        id: 1,
        text: "item 1"
      },
      2: {
        id: 2,
        text: "item 2"
      }
    }
  });

  TodoFlow.dispatch(ActionTypes.Edit, 1);

  expect(TodoFlow.getState().editing).toEqual({
    id: 1,
    text: "item 1"
  });

  TodoFlow.dispatch(ActionTypes.Update, "new text");

  expect(TodoFlow.getState().editing).toEqual({
    id: 1,
    text: "new text"
  });

  TodoFlow.dispatch(ActionTypes.Cancel);

  expect(TodoFlow.getState().editing).not.toBeDefined();

  TodoFlow.dispatch(ActionTypes.Edit, 1);

  TodoFlow.dispatch(ActionTypes.Update, "new text");

  TodoFlow.dispatch(ActionTypes.Save);

  expect(TodoFlow.getState()).toEqual({
    ids: [1, 2],
    data: {
      1: {
        id: 1,
        text: "new text"
      },
      2: {
        id: 2,
        text: "item 2"
      }
    }
  });
});

test("TextFormatFlow should work properly", () => {
  const f = $.state({
    bold: false,
    italic: false,
    underline: false
  }).on({
    bold: $.toggleState("bold").restart(),
    italic: $.toggleState("italic").restart(),
    underline: $.toggleState("underline").restart()
  });

  expect(f.getState()).toEqual({
    bold: false,
    italic: false,
    underline: false
  });

  f.dispatch("bold");

  expect(f.getState()).toEqual({
    bold: true,
    italic: false,
    underline: false
  });

  f.dispatch("bold");

  expect(f.getState()).toEqual({
    bold: false,
    italic: false,
    underline: false
  });
});
