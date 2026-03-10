defmodule Stages.Counter do
  use GenServer

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, 0, opts)
  end

  @impl true
  def init(count), do: {:ok, count}

  @impl true
  def handle_call(:increment, _from, count), do: {:reply, count + 1, count + 1}
  def handle_call(:get, _from, count), do: {:reply, count, count}

  @impl true
  def handle_cast(:increment, count), do: {:noreply, count + 1}
end

defmodule Stages.Echo do
  use GenServer

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, nil, opts)
  end

  @impl true
  def init(_), do: {:ok, nil}

  @impl true
  def handle_call(message, _from, state), do: {:reply, message, state}
end

defmodule Stages.Forwarder do
  use GenServer

  def start_link(target, opts \\ []) do
    GenServer.start_link(__MODULE__, target, opts)
  end

  @impl true
  def init(target), do: {:ok, target}

  @impl true
  def handle_call(message, _from, target) do
    result = GenServer.call(target, message)
    {:reply, result, target}
  end
end
