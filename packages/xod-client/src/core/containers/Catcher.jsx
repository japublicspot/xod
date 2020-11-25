import React from 'react';
import PropTypes from 'prop-types';
import { connect } from 'react-redux';
import { bindActionCreators } from 'redux';

import { recoverState } from '../actions';

class Catcher extends React.Component {
  constructor(props) {
    super(props);

    this.timer = null;
    this.stableState = props.state;
    this.state = {
      error: null,
      errorInfo: null,
    };

    this.onClose = this.onClose.bind(this);
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ error, errorInfo });
    setTimeout(() => {
      // Recover on the next tick after <App> component will be mounted again
      // and default project will be loaded
      this.props.recoverState(this.stableState);
    }, 0);
    clearTimeout(this.timer);
  }

  shouldComponentUpdate(nextProps, nextState) {
    return this.stableState !== nextProps.state || !nextState.error;
  }

  componentDidUpdate(prevProps) {
    if (!this.state.error && prevProps.state !== this.props.state) {
      clearTimeout(this.timer);
      // postpone updating state to the next tick
      // to catch the error before it will be updated
      this.timer = setTimeout(() => {
        console.log('set stable state');
        this.stableState = this.props.state;
      }, 0);
    }
  }

  onClose() {
    this.setState({ error: null, errorInfo: null });
  }

  render() {
    return (
      <React.Fragment>
        {this.state.error ? (
          <div
            style={{
              background: '#f00',
              height: '300px',
              width: '100%',
              position: 'absolute',
              bottom: 0,
              left: 0,
              boxSizing: 'border-box',
              overflowY: 'scroll',
              padding: '10px',
              zIndex: 9999,
            }}
          >
            <h1>Something went wrong</h1>
            <pre>
              {this.state.error.toString()}
              {this.state.errorInfo.componentStack}
            </pre>
            <hr />
            <button onClick={this.onClose}>CLOSE</button>
          </div>
        ) : null}
        {this.props.children}
      </React.Fragment>
    );
  }
  // <pre>{JSON.stringify(this.stableState, null, 2)}</pre>
}

Catcher.defaultProps = {
  state: {},
};

Catcher.propTypes = {
  state: PropTypes.object,
  children: PropTypes.element.isRequired,
  recoverState: PropTypes.func.isRequired,
};

export default connect(
  x => ({ state: x }),
  dispatch => bindActionCreators({ recoverState }, dispatch)
)(Catcher);
