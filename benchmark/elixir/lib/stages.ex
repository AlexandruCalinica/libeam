defmodule Stages.FiniteProducer do
  @moduledoc """
  Producer that emits exactly `total` sequential integers (0..total-1).
  Returns empty list once all events have been emitted.
  """
  use GenStage

  def start_link(opts) do
    GenStage.start_link(__MODULE__, opts)
  end

  @impl true
  def init(opts) do
    total = Keyword.fetch!(opts, :total)
    dispatcher = Keyword.get(opts, :dispatcher, GenStage.DemandDispatcher)
    demand_mode = Keyword.get(opts, :demand, :forward)

    {:producer, %{total: total, counter: 0}, dispatcher: dispatcher, demand: demand_mode}
  end

  @impl true
  def handle_demand(demand, %{total: total, counter: counter} = state) do
    remaining = total - counter

    if remaining <= 0 do
      {:noreply, [], state}
    else
      count = min(demand, remaining)
      events = Enum.to_list(counter..(counter + count - 1))
      {:noreply, events, %{state | counter: counter + count}}
    end
  end
end

defmodule Stages.TrackingConsumer do
  @moduledoc """
  Consumer that counts received events via a shared :counters ref.
  Sends {ref, :done} to the notify pid when total reaches expected.
  """
  use GenStage

  def start_link(opts) do
    GenStage.start_link(__MODULE__, opts)
  end

  @impl true
  def init(opts) do
    {:consumer,
     %{
       counter: Keyword.fetch!(opts, :counter),
       expected: Keyword.fetch!(opts, :expected),
       notify: Keyword.fetch!(opts, :notify),
       ref: Keyword.fetch!(opts, :ref)
     }}
  end

  @impl true
  def handle_events(events, _from, state) do
    :counters.add(state.counter, 1, length(events))
    count = :counters.get(state.counter, 1)

    if count >= state.expected do
      send(state.notify, {state.ref, :done})
    end

    {:noreply, [], state}
  end
end

defmodule Stages.PassthroughPC do
  @moduledoc """
  ProducerConsumer that forwards events unchanged.
  """
  use GenStage

  def start_link(opts \\ []) do
    GenStage.start_link(__MODULE__, opts)
  end

  @impl true
  def init(opts) do
    dispatcher = Keyword.get(opts, :dispatcher, GenStage.DemandDispatcher)
    {:producer_consumer, nil, dispatcher: dispatcher}
  end

  @impl true
  def handle_events(events, _from, state) do
    {:noreply, events, state}
  end
end

defmodule Stages.BenchWorker do
  @moduledoc """
  Minimal worker for ConsumerSupervisor benchmarks.
  Increments shared counter on start, then exits immediately.
  """
  use GenServer, restart: :temporary

  def start_link(counter, expected, notify, ref, _event) do
    GenServer.start_link(__MODULE__, {counter, expected, notify, ref})
  end

  @impl true
  def init({counter, expected, notify, ref}) do
    :counters.add(counter, 1, 1)
    count = :counters.get(counter, 1)

    if count >= expected do
      send(notify, {ref, :done})
    end

    {:ok, nil, {:continue, :stop}}
  end

  @impl true
  def handle_continue(:stop, state) do
    {:stop, :normal, state}
  end
end

defmodule Stages.BenchConsumerSupervisor do
  @moduledoc """
  ConsumerSupervisor that spawns a BenchWorker per event.
  """
  use ConsumerSupervisor

  def start_link(opts) do
    ConsumerSupervisor.start_link(__MODULE__, opts)
  end

  @impl true
  def init(opts) do
    counter = Keyword.fetch!(opts, :counter)
    expected = Keyword.fetch!(opts, :expected)
    notify = Keyword.fetch!(opts, :notify)
    ref = Keyword.fetch!(opts, :ref)

    children = [
      %{
        id: Stages.BenchWorker,
        start: {Stages.BenchWorker, :start_link, [counter, expected, notify, ref]},
        restart: :temporary
      }
    ]

    ConsumerSupervisor.init(children, strategy: :one_for_one)
  end
end
