const asyncResultTypes = {
  payload: 1,
  meta: 2
};

const defaultReducer = ({ state }) => state;
const defaultToggler = ({ state }) => !state;
const strictComparer = (a, b) => a === b;

const rootId = "@root";
const parentId = "@parent";

class Flow {
  __initialized = false;
  __internal = false;
  __asyncResultType = asyncResultTypes.payload;
  __childrenMap = {};
  __childrenById = {};
  __stateMap = {};
  __subscriptions = new Set();
  __callbackCache = {};
  __transformFlows = [];
  __predefinedFlows = {};
  __debounce = 0;
  __debounceTimerId;
  __dispatchToken;
  __jumpToFlow;
  __id;
  __condition;
  __prop;
  __reducer = defaultReducer;
  __defaultValue;
  __state;
  __success;
  __failure;
  __transfer;
  __currentFlow = this;

  __set = (name, value, callback) => {
    const prevValue = this[name];
    this[name] = value;
    callback && callback(prevValue);
    return this;
  };

  __isEnabled = externalDispatch => {
    const currentFlow = this.__currentFlow;
    if (currentFlow.__internal && externalDispatch) {
      return false;
    }

    if (!currentFlow.__condition) return true;

    const context = currentFlow.__getContext(this.getState);
    return this.__condition(context);
  };

  __getContext = getState => {
    const state = getState();
    const context = { state, getState, $state: state };
    if (this.__prop) {
      // extract multiple state props
      if (Array.isArray(this.__prop)) {
        context.state = this.__prop.reduce((obj, key) => {
          obj[key] = context.$state[key];
          return obj;
        }, {});
      } else {
        // extract single state prop
        context.state = context.$state[this.__prop];
      }
    }
    Object.keys(this.__stateMap).forEach(
      key => (context[key] = this.__stateMap[key].getState())
    );
    Object.defineProperty(context, "mutate", {
      get() {
        if (!context.__mutator) {
          context.__mutator = new State(context.state);
        }
        return context.__mutator;
      }
    });
    return context;
  };

  __updateState = state => {
    if (this.__state === state) return;
    const currentFlow = this.__currentFlow;
    const prevState = this.__state;

    if (currentFlow.__prop) {
      if (Array.isArray(currentFlow.__prop)) {
        currentFlow.__prop.forEach(prop => {
          if (prevState[prop] !== state[prop]) {
            if (prevState === this.__state) {
              this.__state = clone(prevState);
            }
            this.__state[prop] = state[prop];
          }
        });
      } else if (prevState[currentFlow.__prop] !== state) {
        this.__state = clone(prevState);
        this.__state[currentFlow.__prop] = state;
      }
    } else {
      this.__state = state;
    }
    if (this.__state !== prevState) {
      const context = {
        state: this.__state,
        current: this.__currentFlow
      };
      for (const subscription of this.__subscriptions) {
        subscription(context);
      }
    }
  };

  __eval = (...args) => {
    const currentFlow = this.__currentFlow;
    try {
      if (currentFlow.__reducer) {
        const context = currentFlow.__getContext(this.getState);
        let result = currentFlow.__reducer(context, ...args);
        if (typeof result === "function") {
          result = result(context.mutate);
        }

        if (result && result.then) {
          return this.__evalAsync(result, context.__mutator);
        }

        this.__updateState(
          context.__mutator ? context.__mutator.value : result
        );
        return this.__tryTransitionToSuccess(result);
      }

      this.__updateState(currentFlow.__defaultValue);
      return this.__tryTransitionToSuccess(currentFlow.__defaultValue);
    } catch (ex) {
      return this.__tryTransitionToFailure(ex);
    }
  };

  __tryTransitionToSuccess = payload => {
    if (!this.__currentFlow.__success) {
      return this.__tryTransitionToNext();
    }
    this.__currentFlow = this.__currentFlow.__success;
    const result = this.__eval(payload);
    if (result && result.then) {
      return result.then(() => this.__tryTransitionToNext());
    }
    return result;
  };

  __tryTransitionToNext = () => {
    const currentFlow = this.__currentFlow;
    if (currentFlow.__jumpToFlow) {
      let localFlowPath = currentFlow.__jumpToFlow;
      if (typeof localFlowPath === "function") {
        const f = localFlowPath;
        localFlowPath = f(this.getState());
      }
      const nextFlow =
        localFlowPath === rootId
          ? this
          : localFlowPath === parentId
          ? currentFlow.__parent
          : this.__find(localFlowPath, currentFlow);

      if (nextFlow) {
        this.__currentFlow = nextFlow;
      }
    }

    const promises = [];
    this.__transformFlows.forEach(([flow, path, ...args]) => {
      const result = flow.__dispatch([path].concat(args));
      if (result && result.then) {
        promises.push(result);
      }
    });

    if (promises.length) {
      return Promise.all(promises);
    }
  };

  __tryTransitionToFailure = error => {
    if (!this.__currentFlow.__failure) {
      throw error;
    }
    this.__currentFlow = this.__currentFlow.__failure;
    return this.__eval(error);
  };

  __findById = id => {
    return this.__childrenById[id];
  };

  __find = (path, currentFlow = this) => {
    const parts = path.toString().split(".");
    const seed =
      parts[0][0] === "#"
        ? this.__findById(parts.shift().substr(1))
        : currentFlow;
    return parts.reduce(
      (parent, prop) => (parent ? parent.__childrenMap[prop] : undefined),
      seed
    );
  };

  __init = () => {
    if (!this.__initialized && !this.__parent) {
      this.__initialized = true;
      this.__eval();
    }
  };

  __collectAllDescendants = map => {
    if (this.__id) {
      map[this.__id] = this;
    }
    Object.values(this.__childrenMap).forEach(childFlow =>
      childFlow.__collectAllDescendants(map)
    );
  };

  __resolveFlow = (flow, name) => {
    if (this.__parent) {
      return this.__parent.__resolveFlow(flow, name);
    }
    if (flow === true) {
      flow = name;
    }
    if (typeof flow === "string") {
      if (!(flow in this.__predefinedFlows)) {
        throw new Error(`No flow named ${flow} found`);
      }
      return typeof this.__predefinedFlows[flow] === "function"
        ? this.__predefinedFlows[flow]()
        : this.__predefinedFlows[flow];
    }
    return flow;
  };

  __evalAsync = async (promise, mutator) => {
    const currentFlow = this.__currentFlow;
    let done = false;
    let hasError = false;
    const p = promise.then(
      payload => {
        if (mutator) {
          payload = mutator.value;
        }
        done = true;
        if (this.__currentFlow !== currentFlow) return;
        if (currentFlow.__asyncResultType === asyncResultTypes.meta) {
          this.__updateState({ done, payload });
        } else {
          this.__updateState(payload);
        }
        return this.__tryTransitionToSuccess(payload);
      },
      error => {
        done = true;
        hasError = true;
        if (this.__currentFlow !== currentFlow) return;
        if (currentFlow.__asyncResultType === asyncResultTypes.meta) {
          this.__updateState({ done, error });
        }
        return this.__tryTransitionToFailure(error);
      }
    );

    if (currentFlow.__asyncResultType === asyncResultTypes.meta) {
      if (!done && !hasError) {
        this.__updateState({ loading: true });
      }
    }

    await p;
  };

  internal = () => this.__set("__internal", true);

  reset = () => {
    this.__initialized = false;
    this.__state = undefined;
    this.__currentFlow = this;
    this.__init();
    return this;
  };

  restart = () => this.next(rootId);

  back = () => this.next(parentId);

  define = (name, flow) => {
    this.__predefinedFlows[name] = flow;
    return this;
  };

  transfer = value => this.__set("__transfer", value);

  actionNames = () => {
    if (
      !this.__lastActionNames ||
      this.__lastActionNames.currentFlow !== this.__currentFlow
    ) {
      this.__lastActionNames = Object.keys(this.__currentFlow.__childrenMap);
      this.__lastActionNames.currentFlow = this.__currentFlow;
    }
    return this.__lastActionNames;
  };

  subscribe = subscription => {
    this.__subscriptions.add(subscription);

    return () => {
      this.__subscriptions.delete(subscription);
    };
  };

  debounce = value => this.__set("__debounce", value);

  /**
   * @param value string
   */
  id = value =>
    typeof value === "undefined"
      ? this.__id
      : this.__set("__id", value, prevValue => {
          this.__childrenById[value] = this;
          if (prevValue) {
            throw new Error("Cannot re-assign id");
          }
        });

  use = map =>
    this.__set("__stateMap", prevValue => Object.assign(prevValue, map));

  callback = action => {
    let callback = this.__callbackCache[action];
    if (!callback) {
      this.__callbackCache[action] = callback = (...args) =>
        this.dispatch(action, ...args);
    }
    return callback;
  };

  get value() {
    return this.getState();
  }

  getState = selector => {
    this.__init();

    return selector ? selector(this.__state) : this.__state;
  };

  /**
   * state(defaultValue)
   * state(reducer)
   * state(reducer, defaultValue)
   * state(prop, reducer)
   * state(prop, reducer, defaultValue)
   */
  state = (...args) => {
    if (args.length > 1) {
      if (typeof args[0] === "function") {
        // state(reducer, defaultValue)
        const [reducer, defaultValue] = args;
        this.__set("__reducer", reducer);
        this.__set("__defaultValue", defaultValue);
      } else {
        // state(prop, reducer)
        // state(prop, reducer, defaultValue)
        let [prop, reducer, defaultValue] = args;
        this.__set("__prop", prop);
        if (typeof reducer !== "function") {
          // state(prop, defaultValue)
          defaultValue = reducer;
          this.__set("__reducer", () => defaultValue);
          this.__set("__defaultValue", defaultValue);
        } else {
          this.__set("__reducer", reducer);
          this.__set("__defaultValue", defaultValue);
        }
      }
    } else if (typeof args[0] === "function") {
      // state(reducer)
      this.__set("__reducer", args[0]);
    } else {
      // state(defaultValue)
      this.__set("__prop", undefined);
      this.__set("__reducer", undefined);
      this.__set("__defaultValue", args[0]);
    }

    this.__initialized = false;

    return this;
  };

  toggleState = (...props) => {
    if (!props.length) {
      return this.state(defaultToggler);
    }
    return this.state(({ state }) => {
      return props.reduce(
        (obj, prop) => {
          obj[prop] = !obj[prop];
          return obj;
        },
        {
          ...state
        }
      );
    });
  };

  next = (...args) => {
    if (args[0] instanceof Flow) {
      this.__transformFlows.push(args);
    } else {
      this.__jumpToFlow = args[0];
    }

    return this;
  };

  on = (...args) => {
    if (typeof args[0] !== "object") {
      const [childFlowPath, flows] = args;
      const targetChild = this.__find(childFlowPath);
      if (!targetChild) {
        throw new Error("Flow not found " + childFlowPath);
      }
      targetChild.on(flows);
      targetChild.__collectAllDescendants(this.__childrenById);
      return this;
    }

    const flows =
      typeof args[0] !== "object" ? { [args[0]]: args[1] } : args[0];

    Object.entries(flows).forEach(([name, childFlow]) => {
      childFlow = this.__resolveFlow(childFlow, name);
      this.__childrenMap[name] = childFlow;
      childFlow.__parent = this;
      childFlow.__collectAllDescendants(this.__childrenById);
    });

    return this;
  };

  condition = checker => this.__set("__condition", checker);

  asyncPayload = () =>
    this.__set("__asyncResultType", asyncResultTypes.payload);

  asyncMeta = () => this.__set("__asyncResultType", asyncResultTypes.meta);

  success = value => this.__set("__success", this.__resolveFlow(value));

  failure = value => this.__set("__failure", this.__resolveFlow(value));

  dispatch = (...args) => {
    return this.__dispatch(args, true);
  };

  __dispatch = (args, externalDispatch) => {
    this.__init();

    const [path, ...params] = args;
    let flow = this.__find(path, this.__currentFlow);
    if (!flow) return;
    if (!flow.__isEnabled(externalDispatch)) {
      return;
    }

    if (flow.__transfer) {
      let transfer = flow.__transfer;
      if (typeof transfer === "function") {
        const f = transfer;
        transfer = f(this.getState());
      }
      const targetFlow =
        transfer instanceof Flow
          ? transfer
          : this.__find(transfer, this.__currentFlow);
      if (!targetFlow) {
        throw new Error("Cannot transfer to " + transfer);
      }
      flow = targetFlow;
    }

    if (flow.__debounce) {
      const dispatchToken = this.__dispatchToken;
      clearTimeout(flow.__debounceTimerId);
      flow.__debounceTimerId = setTimeout(() => {
        // there is another dispatching called since last time
        if (dispatchToken !== this.__dispatchToken) return;
        clearTimeout(flow.__debounceTimerId);
        this.__currentFlow = flow;
        return this.__eval(...params);
      });
      return;
    }

    this.__dispatchToken = {};
    this.__currentFlow = flow;
    return this.__eval(...params);
  };

  can = action => {
    return !!this.__currentFlow.__childrenMap[action];
  };
}

class State {
  constructor(
    defaultValue,
    { parent, root, prop, compare = strictComparer } = {}
  ) {
    this.__value = defaultValue;
    this.__parent = parent;
    this.__root = root || this;
    this.__prop = prop;
    this.__compare = compare;
  }

  __subStates = new Map();

  __getValue = tryEval => {
    if (this.__parent) {
      // try to get value from its parent
      const parentValue = this.__parent.__getValue(tryEval);
      return tryEval &&
        (typeof parentValue === "undefined" || parentValue === null)
        ? undefined
        : parentValue instanceof State
        ? parentValue.value[this.__prop]
        : parentValue[this.__prop];
    }

    return this.__value;
  };

  __setValue = value => {
    if (this.__parent) {
      const clonedParentValue = clone(this.__parent.value);
      clonedParentValue[this.__prop] = value;
      this.__parent.__setValue(clonedParentValue);
    } else {
      this.__value = value;
    }
  };

  __getSubState = prop => {
    if (this.__value && this.__value[prop] instanceof State)
      return this.__value[prop];

    let subState = this.__subStates.get(prop);
    if (!subState) {
      this.__subStates.set(
        prop,
        (subState = new State(undefined, {
          root: this.__root,
          parent: this,
          prop
        }))
      );
    }
    return subState;
  };

  get value() {
    return this.__getValue();
  }

  set value(value) {
    const currentValue = this.__getValue(true);
    if (this.__compare(value, currentValue)) return;

    this.__setValue(value);
  }

  prop = strings => {
    const path = Array.isArray(strings) ? strings[0] : strings;
    return path
      .toString()
      .split(".")
      .reduce((parent, prop) => parent.__getSubState(prop), this);
  };

  get = path => {
    if (!path) return this.value;
    return this.prop(path).value;
  };

  tap = action => {
    action(this, this.__getValue());
    return this;
  };

  mutate = (action, needClone) => {
    const target = needClone
      ? clone(this.__getValue(true))
      : this.__getValue(true);
    const result = action(target);
    this.value = needClone ? target : result;
    return this;
  };
}

// element helpers
Object.assign(State.prototype, {
  handleChange(e) {
    this.value = e.target.value;
  }
});

/**
 * array helpers
 */
Object.assign(State.prototype, {
  first(defaultValue) {
    const result = this.__getValue()[0];
    if (typeof result === "undefined") return defaultValue;
    return result;
  },
  last(defaultValue) {
    const array = this.__getValue();
    const result = array[array.length - 1];
    if (typeof result === "undefined") return defaultValue;
    return result;
  },
  push(...args) {
    if (!args.length) return this;
    return this.mutate(array => array.push(...args), true);
  },
  pop() {
    return this.mutate(array => array.pop(), true);
  },
  shift() {
    return this.mutate(array => array.shift(), true);
  },
  unshift(...args) {
    if (!args.length) return this;
    return this.mutate(array => array.unshift(...args), true);
  },
  splice(...args) {
    let result = undefined;
    this.mutate(array => {
      result = array.splice(...args);
      return array;
    }, true);
    return result;
  },
  filter(predicate) {
    return this.mutate(array => array.filter(predicate));
  },
  /**
   * orderBy(prop, desc)
   * orderBy({
   *   prop1: true // desc
   *   prop2: false // asc
   * })
   *
   * orderBy([func, true], [func, false])
   */
  orderBy(...args) {
    // { prop1: boolean, prop2: false }
    if (!Array.isArray(args[0])) {
      if (typeof args[0] === "object") {
        args = Object.entries(args[0]);
      } else {
        args = [[args[0], args[1]]];
      }
    }
    // normalize args
    args = args.map(([prop, desc]) => [
      typeof prop === "function" ? prop : obj => obj[prop],
      desc
    ]);

    return this.mutate(
      array =>
        array.sort((a, b) => {
          for (const [func, desc] of args) {
            const aValue = func(a);
            const bValue = func(b);
            if (aValue === bValue) {
              continue;
            }
            if (aValue > bValue) {
              return desc ? -1 : 1;
            }
            return desc ? 1 : -1;
          }
          return 0;
        }),
      true
    );
  },
  sort(sorter) {
    return this.mutate(array => array.sort(sorter), true);
  },
  concat(...args) {
    return this.mutate(array => array.concat(...args));
  },
  fill(...values) {
    return this.mutate(array => array.fill(...values), true);
  },
  flat(...args) {
    return this.mutate(array => array.flat(...args));
  },
  map(...args) {
    return this.mutate(array => array.map(...args));
  },
  reverse(...args) {
    return this.mutate(array => array.reverse(...args), true);
  },
  slice(...args) {
    return this.mutate(array => array.slice(...args));
  },
  exclude(...values) {
    if (!values.length) return this;
    const temp = [];
    const array = this.__getValue();
    for (const item of array) {
      if (!values.includes(item)) {
        temp.push(item);
      }
    }
    if (temp.length !== array.length) {
      return this.set(temp);
    }
    return this;
  },
  remove(...indexes) {
    indexes.sort();
    if (!indexes.length) return this;
    let array = this.__getValue();
    if (indexes[indexes.length - 1] >= array.length) return this;
    array = array.slice(0);
    while (indexes.length) {
      const index = indexes.pop();
      if (index >= array.length) break;
      array.splice(index, 1);
    }
    this.value = array;
    return this;
  },
  filterMap(predicate, mapper) {
    return this.mutate(array => array.filter(predicate).map(mapper));
  },
  swap(sourceIndex, destIndex) {
    return this.mutate(array => {
      const temp = array[sourceIndex];
      array[sourceIndex] = array[destIndex];
      array[destIndex] = temp;
    }, true);
  }
});

// object helpers
Object.assign(State.prototype, {
  def(prop, value) {
    if (arguments.length < 2) {
      return this.mutate(current =>
        typeof current === "undefined" ? value : current
      );
    }
    return this.prop(prop).def(value);
  },
  toggle(...props) {
    if (props.length) {
      return this.mutate(
        obj => props.forEach(prop => (obj[prop] = !obj[prop])),
        true
      );
    }
    return this.mutate(value => !value);
  },
  unset(...props) {
    if (!props.length) return;
    return this.mutate(obj => {
      props.forEach(prop => delete obj[prop]);
    }, true);
  },
  set(prop, value) {
    if (arguments.length < 2) {
      this.value = prop;
      return this;
    }
    this.prop(prop).value = value;
    return this;
  },
  assign(...objs) {
    if (!objs.length) return;
    return this.mutate(obj => Object.assign({}, obj, ...objs));
  },
  merge() {}
});

const modifyDate = (
  date,
  year = 0,
  month = 0,
  day = 0,
  hour = 0,
  minute = 0,
  second = 0,
  milli = 0
) =>
  new Date(
    date.getFullYear() + year,
    date.getMonth() + month,
    date.getDate() + day,
    date.getHours() + hour,
    date.getMinutes() + minute,
    date.getSeconds() + second,
    date.getMilliseconds() + milli
  );

const dateModifiers = {
  month(date, value) {
    return modifyDate(date, 0, value);
  },
  year(date, value) {
    return modifyDate(date, value);
  },
  day(date, value) {
    return modifyDate(date, 0, 0, value);
  },
  week(date, value) {
    return modifyDate(date, 0, 0, value * 7);
  },
  hour(date, value) {
    return modifyDate(date, 0, 0, 0, value);
  },
  minute(date, value) {
    return modifyDate(date, 0, 0, 0, 0, value);
  },
  second(date, value) {
    return modifyDate(date, 0, 0, 0, 0, 0, value);
  },
  milli(date, value) {
    return modifyDate(date, 0, 0, 0, 0, 0, 0, value);
  }
};

// add shortcuts
dateModifiers.D = dateModifiers.day;
dateModifiers.M = dateModifiers.month;
dateModifiers.Y = dateModifiers.year;
dateModifiers.W = dateModifiers.week;
dateModifiers.h = dateModifiers.hour;
dateModifiers.m = dateModifiers.minute;
dateModifiers.s = dateModifiers.second;
dateModifiers.ms = dateModifiers.milli;

// value helpers
Object.assign(State.prototype, {
  add(...args) {
    return this.mutate(current => {
      // support tuple [value, duration]
      if (Array.isArray(args[0])) {
        args = args.flat();
      }
      if (current instanceof Date) {
        const modify = (date, value, duration) => {
          if (duration in dateModifiers) {
            return dateModifiers[duration](current, value);
          }
          throw new Error("Invalid date duration " + duration);
        };

        while (args.length) {
          current = modify(current, args.shift(), args.shift());
        }

        return current;
      } else {
        return current + args[0];
      }
    });
  },
  mul(value) {
    return this.mutate(current => current * value);
  },
  div(value) {
    return this.mutate(current => current / value);
  }
});

// string helpers
Object.assign(State.prototype, {
  replace(...args) {
    return this.mutate(current => current.replace(...args));
  },
  substr(...args) {
    return this.mutate(current => current.substr(...args));
  },
  substring(...args) {
    return this.mutate(current => current.substring(...args));
  },
  trim(...args) {
    return this.mutate(current => current.trim(...args));
  },
  upper() {
    return this.mutate(current => current.toUpperCase());
  },
  lower() {
    return this.mutate(current => current.toLowerCase());
  }
});

export function arrayEqual(a, b) {
  if (!a || b) return false;
  if (!b || a) return false;
  return a.length === b.length && a.every((i, index) => i === b[index]);
}

export function clone(value) {
  if (Array.isArray(value)) return value.slice(0);
  return Object.assign({}, value);
}

const template = new Flow().id("@temp");

function defaultExport(transferTo) {
  return new Flow().transfer(transferTo);
}

export default Object.keys(template).reduce((obj, key) => {
  if (key[0] === "_" && key[1] === "_") return obj;
  if (typeof template[key] !== "function") return obj;
  obj[key] = (...args) => {
    const f = new Flow();
    return f[key](...args);
  };

  return obj;
}, defaultExport);
